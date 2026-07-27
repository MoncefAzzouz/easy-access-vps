import * as path from 'node:path';
import { Client, ClientChannel, ConnectConfig, SFTPWrapper, Stats } from 'ssh2';
import * as vscode from 'vscode';

const SCHEME = 'easy-vps';
const PROFILES_KEY = 'easy-vps.profiles';
const LAST_PATH_KEY = 'easy-vps.lastRemotePath';
const HOST_KEYS_KEY = 'easy-vps.hostKeys';
type AuthType = 'password' | 'privateKey';
const COMMON_REMOTE_PATHS = ['/', '/root', '/home', '/var/www', '/etc', '/opt', '/srv', '/tmp'];

interface ConnectionProfile {
	id: string;
	name: string;
	host: string;
	port: number;
	username: string;
	remotePath: string;
	authType: AuthType;
	privateKeyPath?: string;
}

interface ActiveConnection {
	client: Client;
	sftp: SFTPWrapper;
}

export function activate(context: vscode.ExtensionContext): void {
	const provider = new SftpFileSystemProvider(context);
	const connections = new ConnectionTreeProvider(context, provider);
	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider(SCHEME, provider, {
			isCaseSensitive: true,
			isReadonly: false,
		}),
		vscode.window.registerTreeDataProvider('easyVps.connections', connections),
		vscode.commands.registerCommand('easy-vps.add', () => quickAddVps(context, provider, connections)),
		vscode.commands.registerCommand('easy-vps.connect', (item?: ConnectionItem) =>
			item ? connectProfile(context, provider, item.profile, connections) : connectToVps(context, provider, connections)),
		vscode.commands.registerCommand('easy-vps.advancedAdd', async () => {
			const profile = await promptForProfile();
			if (profile) {
				await connectProfile(context, provider, profile, connections);
			}
		}),
		vscode.commands.registerCommand('easy-vps.test', (item: ConnectionItem) =>
			testConnection(context, provider, item.profile)),
		vscode.commands.registerCommand('easy-vps.edit', (item: ConnectionItem) =>
			editConnection(context, provider, connections, item.profile)),
		vscode.commands.registerCommand('easy-vps.openPath', (item: RemotePathItem) =>
			openRemotePath(context, provider, connections, item.profile, item.remotePath)),
		vscode.commands.registerCommand('easy-vps.importSshConfig', () =>
			importSshConfig(context, connections)),
		vscode.commands.registerCommand('easy-vps.refresh', () => connections.refresh()),
		vscode.commands.registerCommand('easy-vps.removeFromExplorer', (uri?: vscode.Uri) =>
			removeFromExplorer(provider, connections, uri)),
		vscode.commands.registerCommand('easy-vps.openTerminal', (target?: vscode.Uri | ConnectionTreeItem) =>
			openVpsTerminal(context, target)),
		vscode.commands.registerCommand('easy-vps.searchRemote', (uri?: vscode.Uri) =>
			searchRemoteFiles(provider, uri)),
		vscode.commands.registerCommand('easy-vps.upload', (uri?: vscode.Uri) =>
			uploadToVps(provider, uri)),
		vscode.commands.registerCommand('easy-vps.download', (uri?: vscode.Uri) =>
			downloadFromVps(uri)),
		vscode.commands.registerCommand('easy-vps.permissions', (uri?: vscode.Uri) =>
			changeRemotePermissions(provider, uri)),
		vscode.commands.registerCommand('easy-vps.disconnect', () => disconnectFromVps(provider)),
		vscode.commands.registerCommand('easy-vps.forgetConnection', (item?: ConnectionItem) =>
			forgetConnection(context, provider, connections, item?.profile)),
		provider,
	);
}

async function searchRemoteFiles(provider: SftpFileSystemProvider, uri?: vscode.Uri): Promise<void> {
	const root = await remoteTarget(uri, true);
	if (!root) { return; }
	const query = await vscode.window.showInputBox({
		prompt: `Search file and folder names below ${root.path}`,
		placeHolder: 'Name to find',
		ignoreFocusOut: true,
	});
	if (!query?.trim()) { return; }
	const matches = await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: `Searching ${root.path}…`,
		cancellable: true,
	}, (_progress, token) => provider.search(root, query.trim(), token));
	if (matches.length === 0) {
		vscode.window.showInformationMessage(`No remote items matched “${query}”.`);
		return;
	}
	const selected = await vscode.window.showQuickPick(matches.map((match) => ({
		label: `$(file) ${path.posix.basename(match.path)}`,
		description: match.path,
		uri: match,
	})), { placeHolder: `${matches.length} result${matches.length === 1 ? '' : 's'}` });
	if (!selected) { return; }
	const stat = await vscode.workspace.fs.stat(selected.uri);
	if ((stat.type & vscode.FileType.Directory) !== 0) {
		await vscode.commands.executeCommand('revealInExplorer', selected.uri);
	} else {
		await vscode.window.showTextDocument(selected.uri);
	}
}

async function uploadToVps(_provider: SftpFileSystemProvider, uri?: vscode.Uri): Promise<void> {
	const target = await remoteTarget(uri, true);
	if (!target) { return; }
	const sources = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: true,
		canSelectMany: true,
		openLabel: 'Upload to VPS',
	});
	if (!sources?.length) { return; }
	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: `Uploading ${sources.length} item${sources.length === 1 ? '' : 's'}…`,
		cancellable: true,
	}, async (progress, token) => {
		for (let index = 0; index < sources.length; index += 1) {
			if (token.isCancellationRequested) { break; }
			progress.report({ message: path.basename(sources[index].fsPath), increment: 100 / sources.length });
			await copyAcrossFileSystems(sources[index], vscode.Uri.joinPath(target, path.basename(sources[index].fsPath)), token);
		}
	});
}

async function downloadFromVps(uri?: vscode.Uri): Promise<void> {
	const source = await remoteTarget(uri, false);
	if (!source) { return; }
	const destinations = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: 'Download here',
	});
	if (!destinations?.[0]) { return; }
	const destination = vscode.Uri.joinPath(destinations[0], path.posix.basename(source.path) || source.authority);
	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: `Downloading ${path.posix.basename(source.path)}…`,
		cancellable: true,
	}, (_progress, token) => copyAcrossFileSystems(source, destination, token));
}

async function copyAcrossFileSystems(source: vscode.Uri, destination: vscode.Uri, token: vscode.CancellationToken): Promise<void> {
	if (token.isCancellationRequested) { return; }
	const stat = await vscode.workspace.fs.stat(source);
	if ((stat.type & vscode.FileType.Directory) !== 0) {
		await vscode.workspace.fs.createDirectory(destination);
		for (const [name] of await vscode.workspace.fs.readDirectory(source)) {
			await copyAcrossFileSystems(vscode.Uri.joinPath(source, name), vscode.Uri.joinPath(destination, name), token);
			if (token.isCancellationRequested) { return; }
		}
	} else {
		await vscode.workspace.fs.writeFile(destination, await vscode.workspace.fs.readFile(source));
	}
}

async function changeRemotePermissions(provider: SftpFileSystemProvider, uri?: vscode.Uri): Promise<void> {
	const target = await remoteTarget(uri, false);
	if (!target) { return; }
	const current = await provider.mode(target);
	const value = await vscode.window.showInputBox({
		prompt: `Unix permissions for ${path.posix.basename(target.path) || target.path}`,
		value: (current & 0o7777).toString(8).padStart(3, '0'),
		placeHolder: '755',
		validateInput: (input) => /^[0-7]{3,4}$/.test(input) ? undefined : 'Enter 3 or 4 octal digits, for example 755.',
	});
	if (!value) { return; }
	await provider.chmod(target, Number.parseInt(value, 8));
	vscode.window.showInformationMessage(`Permissions changed to ${value}.`);
}

async function remoteTarget(uri: vscode.Uri | undefined, requireDirectory: boolean): Promise<vscode.Uri | undefined> {
	let target = uri?.scheme === SCHEME ? uri : vscode.window.activeTextEditor?.document.uri;
	if (target?.scheme !== SCHEME) {
		target = (await chooseRemoteWorkspaceFolder('Choose a VPS'))?.uri;
	}
	if (!target) { return undefined; }
	if (requireDirectory) {
		const stat = await vscode.workspace.fs.stat(target);
		if ((stat.type & vscode.FileType.Directory) === 0) {
			target = vscode.Uri.joinPath(target, '..');
		}
	}
	return target;
}

async function openVpsTerminal(
	context: vscode.ExtensionContext,
	target?: vscode.Uri | ConnectionTreeItem,
): Promise<void> {
	let uri = target instanceof vscode.Uri ? target : undefined;
	let profile = target instanceof ConnectionItem || target instanceof RemotePathItem ? target.profile : undefined;
	let remoteDirectory = target instanceof RemotePathItem ? target.remotePath : profile?.remotePath;

	if (!uri && !profile && vscode.window.activeTextEditor?.document.uri.scheme === SCHEME) {
		uri = vscode.window.activeTextEditor.document.uri;
	}
	if (uri?.scheme === SCHEME) {
		profile = getProfiles(context).find((item) => item.id === uri?.authority);
		if (profile) {
			try {
				const stat = await vscode.workspace.fs.stat(uri);
				remoteDirectory = (stat.type & vscode.FileType.Directory) !== 0 ? uri.path : path.posix.dirname(uri.path);
			} catch {
				remoteDirectory = path.posix.dirname(uri.path);
			}
		}
	}
	if (!profile) {
		const selected = await vscode.window.showQuickPick(
			getProfiles(context).map((item) => ({ label: item.name, description: `${item.username}@${item.host}`, profile: item })),
			{ placeHolder: 'Open a terminal on which VPS?' },
		);
		profile = selected?.profile;
	}
	if (!profile) { return; }
	remoteDirectory ??= profile.remotePath;

	let password = profile.authType === 'password' ? await context.secrets.get(secretKey(profile.id)) : undefined;
	if (profile.authType === 'password' && !password) {
		password = await vscode.window.showInputBox({
			prompt: `SSH password for ${profile.username}@${profile.host}`,
			password: true,
			ignoreFocusOut: true,
		});
		if (password === undefined) { return; }
		await context.secrets.store(secretKey(profile.id), password);
	}

	try {
		const config = await createConnectConfig(context, profile, password);
		const terminal = vscode.window.createTerminal({
			name: `${profile.name}: ${remoteDirectory}`,
			pty: new SshPseudoterminal(config, remoteDirectory),
			iconPath: new vscode.ThemeIcon('remote'),
		});
		terminal.show();
	} catch (error) {
		vscode.window.showErrorMessage(`Could not open VPS terminal: ${errorMessage(error)}`);
	}
}

class SshPseudoterminal implements vscode.Pseudoterminal {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly closeEmitter = new vscode.EventEmitter<number | void>();
	readonly onDidWrite = this.writeEmitter.event;
	readonly onDidClose = this.closeEmitter.event;
	private readonly client = new Client();
	private channel?: ClientChannel;
	private closed = false;

	constructor(private readonly config: ConnectConfig, private readonly cwd: string) { }

	open(dimensions?: vscode.TerminalDimensions): void {
		this.writeEmitter.fire(`\x1b[36mConnecting to ${this.config.username}@${this.config.host}…\x1b[0m\r\n`);
		this.client.once('ready', () => {
			this.client.shell({
				term: 'xterm-256color',
				cols: dimensions?.columns ?? 80,
				rows: dimensions?.rows ?? 24,
			}, (error, channel) => {
				if (error) { this.fail(error); return; }
				this.channel = channel;
				channel.on('data', (data: Buffer) => this.writeEmitter.fire(data.toString()));
				channel.stderr.on('data', (data: Buffer) => this.writeEmitter.fire(data.toString()));
				channel.once('close', () => this.finish(0));
				channel.write(`cd -- ${shellQuote(this.cwd)}\r`);
			});
		});
		this.client.once('error', (error) => this.fail(error));
		this.client.once('close', () => this.finish());
		this.client.connect(this.config);
	}

	handleInput(data: string): void { this.channel?.write(data); }
	setDimensions(dimensions: vscode.TerminalDimensions): void {
		this.channel?.setWindow(dimensions.rows, dimensions.columns, 0, 0);
	}
	close(): void {
		this.channel?.end();
		this.client.end();
		this.finish();
	}

	private fail(error: Error): void {
		this.writeEmitter.fire(`\r\n\x1b[31mSSH error: ${error.message}\x1b[0m\r\n`);
		this.finish(1);
	}
	private finish(code?: number): void {
		if (this.closed) { return; }
		this.closed = true;
		this.client.end();
		this.closeEmitter.fire(code);
		this.writeEmitter.dispose();
		this.closeEmitter.dispose();
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function removeFromExplorer(
	provider: SftpFileSystemProvider,
	connections: ConnectionTreeProvider,
	uri?: vscode.Uri,
): Promise<void> {
	const folder = uri
		? vscode.workspace.getWorkspaceFolder(uri)
		: await chooseRemoteWorkspaceFolder('Remove which VPS from Explorer?');
	if (!folder || folder.uri.scheme !== SCHEME) { return; }
	const index = vscode.workspace.workspaceFolders?.indexOf(folder) ?? -1;
	if (index >= 0) {
		provider.disconnect(folder.uri.authority);
		vscode.workspace.updateWorkspaceFolders(index, 1);
		connections.refresh();
		vscode.window.showInformationMessage(`${folder.name} was removed from Explorer. Its saved connection is still available.`);
	}
}

async function chooseRemoteWorkspaceFolder(placeHolder: string): Promise<vscode.WorkspaceFolder | undefined> {
	const selected = await vscode.window.showQuickPick(
		remoteWorkspaceFolders().map((folder) => ({ label: folder.name, description: folder.uri.path, folder })),
		{ placeHolder },
	);
	return selected?.folder;
}

async function connectToVps(
	context: vscode.ExtensionContext,
	provider: SftpFileSystemProvider,
	connections: ConnectionTreeProvider,
): Promise<void> {
	const profiles = getProfiles(context);
	const choices: Array<vscode.QuickPickItem & { profile?: ConnectionProfile }> = [
		{ label: '$(add) New VPS connection', description: 'Enter SSH connection details' },
		...profiles.map((profile) => ({
			label: `$(server) ${profile.name}`,
			description: `${profile.username}@${profile.host}:${profile.port}${profile.remotePath}`,
			profile,
		})),
	];
	const choice = await vscode.window.showQuickPick(choices, { placeHolder: 'Choose a VPS connection' });
	if (!choice) {
		return;
	}

	const profile = choice.profile ?? await promptForProfile();
	if (!profile) {
		return;
	}
	await connectProfile(context, provider, profile, connections);
}

async function connectProfile(
	context: vscode.ExtensionContext,
	provider: SftpFileSystemProvider,
	profile: ConnectionProfile,
	connections?: ConnectionTreeProvider,
): Promise<void> {
	const savedMatch = getProfiles(context).find((saved) => sameServer(saved, profile));
	if (savedMatch && savedMatch.id !== profile.id) {
		profile.id = savedMatch.id;
	}
	let secret: string | undefined;
	if (profile.authType === 'password') {
		secret = await context.secrets.get(secretKey(profile.id));
		if (!secret) {
			secret = await vscode.window.showInputBox({
				prompt: `SSH password for ${profile.username}@${profile.host}`,
				password: true,
				ignoreFocusOut: true,
			});
			if (secret === undefined) {
				return;
			}
		}
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `Connecting to ${profile.name}…`,
			cancellable: false,
		},
		async () => {
			try {
				await provider.connect(profile, secret);
				if (profile.authType === 'password' && secret) {
					await context.secrets.store(secretKey(profile.id), secret);
				}
				await saveProfile(context, profile);
				await context.globalState.update(LAST_PATH_KEY, profile.remotePath);
				connections?.refresh();
				const workspaceUri = vscode.Uri.from({ scheme: SCHEME, authority: profile.id, path: '/' });
				const targetUri = vscode.Uri.from({ scheme: SCHEME, authority: profile.id, path: profile.remotePath });
				const profiles = getProfiles(context);
				const matchingIndexes = (vscode.workspace.workspaceFolders ?? [])
					.map((folder, index) => ({ folder, index }))
					.filter(({ folder }) => {
						if (folder.uri.scheme !== SCHEME) { return false; }
						const folderProfile = profiles.find((saved) => saved.id === folder.uri.authority);
						return folder.uri.authority === profile.id || Boolean(folderProfile && sameServer(folderProfile, profile));
					})
					.map(({ index }) => index);
				if (matchingIndexes.length === 0) {
					vscode.workspace.updateWorkspaceFolders(
						vscode.workspace.workspaceFolders?.length ?? 0,
						0,
						{ uri: workspaceUri, name: profile.name },
					);
				} else {
					// Keep one stable root entry per server so navigating remote paths does
					// not rebuild Explorer or disturb collapsed local workspace folders.
					for (const index of matchingIndexes.slice(1).reverse()) {
						vscode.workspace.updateWorkspaceFolders(index, 1);
					}
					const existing = vscode.workspace.workspaceFolders?.[matchingIndexes[0]];
					if (existing?.uri.toString() !== workspaceUri.toString() || existing.name !== profile.name) {
						vscode.workspace.updateWorkspaceFolders(matchingIndexes[0], 1, { uri: workspaceUri, name: profile.name });
					}
				}
				await vscode.commands.executeCommand('revealInExplorer', targetUri);
				vscode.window.showInformationMessage(`${profile.name} is available in Explorer.`);
			} catch (error) {
				provider.disconnect(profile.id);
				vscode.window.showErrorMessage(`Could not connect to ${profile.name}: ${errorMessage(error)}`);
			}
		},
	);
}

async function quickAddVps(
	context: vscode.ExtensionContext,
	provider: SftpFileSystemProvider,
	connections: ConnectionTreeProvider,
): Promise<void> {
	const address = await ask(
		'SSH address',
		'root@203.0.113.10 or ubuntu@example.com:2222',
		undefined,
		(value) => parseSshAddress(value) ? undefined : 'Use username@host or username@host:port',
	);
	if (!address) {
		return;
	}
	const parsed = parseSshAddress(address);
	if (!parsed) {
		return;
	}
	const profile: ConnectionProfile = {
		id: `${slug(parsed.host)}-${Date.now().toString(36)}`,
		name: parsed.host,
		host: parsed.host,
		port: parsed.port,
		username: parsed.username,
		remotePath: context.globalState.get<string>(LAST_PATH_KEY, '/'),
		authType: 'password',
	};
	await connectProfile(context, provider, profile, connections);
}

function parseSshAddress(value: string): { username: string; host: string; port: number } | undefined {
	const match = /^([^@\s]+)@([^:\s]+)(?::(\d{1,5}))?$/.exec(value.trim());
	if (!match) {
		return undefined;
	}
	const port = Number(match[3] ?? '22');
	if (port < 1 || port > 65535) {
		return undefined;
	}
	return { username: match[1], host: match[2], port };
}

async function promptForProfile(): Promise<ConnectionProfile | undefined> {
	const host = await ask('VPS hostname or IP address', 'Example: 203.0.113.10');
	if (!host) {
		return undefined;
	}
	const portText = await ask('SSH port', 'Usually 22', '22', (value) => {
		const port = Number(value);
		return Number.isInteger(port) && port > 0 && port <= 65535 ? undefined : 'Enter a port from 1 to 65535';
	});
	if (!portText) {
		return undefined;
	}
	const username = await ask('SSH username', 'Example: root or ubuntu');
	if (!username) {
		return undefined;
	}
	const remotePath = await ask('Remote folder to open', 'Example: /var/www', '/');
	if (!remotePath) {
		return undefined;
	}
	if (!remotePath.startsWith('/')) {
		vscode.window.showErrorMessage('The remote folder must be an absolute path beginning with /.');
		return undefined;
	}
	const auth = await vscode.window.showQuickPick(
		[
			{ label: '$(key) SSH key', description: 'Recommended', value: 'privateKey' as const },
			{ label: '$(lock) Password', description: 'Stored securely by VS Code', value: 'password' as const },
		],
		{ placeHolder: 'Choose authentication method' },
	);
	if (!auth) {
		return undefined;
	}

	let privateKeyPath: string | undefined;
	if (auth.value === 'privateKey') {
		privateKeyPath = await ask('Private key file', 'Example: ~/.ssh/id_ed25519', '~/.ssh/id_ed25519');
		if (!privateKeyPath) {
			return undefined;
		}
	}
	const name = await ask('Connection name', 'Shown in Explorer', `${username}@${host}`);
	if (!name) {
		return undefined;
	}

	return {
		id: `${slug(name)}-${Date.now().toString(36)}`,
		name,
		host,
		port: Number(portText),
		username,
		remotePath: path.posix.normalize(remotePath),
		authType: auth.value,
		privateKeyPath,
	};
}

async function disconnectFromVps(provider: SftpFileSystemProvider): Promise<void> {
	const folders = remoteWorkspaceFolders();
	const selected = await vscode.window.showQuickPick(
		folders.map((folder) => ({ label: folder.name, description: folder.uri.authority, folder })),
		{ placeHolder: 'Disconnect which VPS?' },
	);
	if (!selected) {
		return;
	}
	provider.disconnect(selected.folder.uri.authority);
	const index = vscode.workspace.workspaceFolders?.indexOf(selected.folder);
	if (index !== undefined && index >= 0) {
		vscode.workspace.updateWorkspaceFolders(index, 1);
	}
}

async function forgetConnection(
	context: vscode.ExtensionContext,
	provider: SftpFileSystemProvider,
	connections: ConnectionTreeProvider,
	profile?: ConnectionProfile,
): Promise<void> {
	const profiles = getProfiles(context);
	const selected = profile ? { profile } : await vscode.window.showQuickPick(
		profiles.map((profile) => ({ label: profile.name, description: `${profile.username}@${profile.host}`, profile })),
		{ placeHolder: 'Forget which saved connection?' },
	);
	if (!selected) {
		return;
	}
	provider.disconnect(selected.profile.id);
	await context.secrets.delete(secretKey(selected.profile.id));
	await context.globalState.update(PROFILES_KEY, profiles.filter((item) => item.id !== selected.profile.id));
	connections.refresh();
	for (const folder of remoteWorkspaceFolders().filter((item) => item.uri.authority === selected.profile.id)) {
		const index = vscode.workspace.workspaceFolders?.indexOf(folder);
		if (index !== undefined && index >= 0) {
			vscode.workspace.updateWorkspaceFolders(index, 1);
		}
	}
}

class ConnectionItem extends vscode.TreeItem {
	constructor(readonly profile: ConnectionProfile, connected: boolean) {
		super(profile.name, vscode.TreeItemCollapsibleState.Collapsed);
		this.description = `${profile.username}@${profile.host}${profile.port === 22 ? '' : `:${profile.port}`}`;
		this.tooltip = `${this.description}${profile.remotePath}`;
		this.contextValue = connected ? 'easyVpsConnected' : 'easyVpsDisconnected';
		this.iconPath = new vscode.ThemeIcon(connected ? 'vm-active' : 'remote');
	}
}

class RemotePathItem extends vscode.TreeItem {
	constructor(readonly profile: ConnectionProfile, readonly remotePath: string, label = remotePath) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.description = label === '..' ? remotePath : remotePath === profile.remotePath ? 'current' : undefined;
		this.tooltip = `Open ${remotePath} on ${profile.name}`;
		this.contextValue = 'easyVpsRemotePath';
		this.iconPath = new vscode.ThemeIcon(remotePath === profile.remotePath ? 'folder-active' : 'folder');
		this.command = { command: 'easy-vps.openPath', title: 'Open Remote Path', arguments: [this] };
	}
}

type ConnectionTreeItem = ConnectionItem | RemotePathItem;

class ConnectionTreeProvider implements vscode.TreeDataProvider<ConnectionTreeItem> {
	private readonly emitter = new vscode.EventEmitter<ConnectionTreeItem | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	constructor(private readonly context: vscode.ExtensionContext, private readonly provider: SftpFileSystemProvider) { }
	getTreeItem(item: ConnectionTreeItem): vscode.TreeItem { return item; }
	getChildren(item?: ConnectionTreeItem): ConnectionTreeItem[] {
		if (item instanceof ConnectionItem) {
			const items: RemotePathItem[] = [];
			if (item.profile.remotePath !== '/') {
				items.push(new RemotePathItem(item.profile, path.posix.dirname(item.profile.remotePath), '..'));
			}
			items.push(...[...new Set([item.profile.remotePath, ...COMMON_REMOTE_PATHS])]
				.map((remotePath) => new RemotePathItem(item.profile, remotePath)));
			return items;
		}
		if (item) { return []; }
		return getProfiles(this.context).map((profile) => new ConnectionItem(profile, this.provider.isConnected(profile.id)));
	}
	refresh(): void { this.emitter.fire(undefined); }
}

async function openRemotePath(
	context: vscode.ExtensionContext,
	provider: SftpFileSystemProvider,
	connections: ConnectionTreeProvider,
	profile: ConnectionProfile,
	remotePath: string,
): Promise<void> {
	const updated = { ...profile, remotePath };
	await connectProfile(context, provider, updated, connections);
}

async function testConnection(context: vscode.ExtensionContext, provider: SftpFileSystemProvider, profile: ConnectionProfile): Promise<void> {
	let password = profile.authType === 'password' ? await context.secrets.get(secretKey(profile.id)) : undefined;
	if (profile.authType === 'password' && !password) {
		password = await vscode.window.showInputBox({ prompt: `Password for ${profile.username}@${profile.host}`, password: true });
	}
	if (profile.authType === 'password' && password === undefined) { return; }
	try {
		await provider.connect(profile, password);
		vscode.window.showInformationMessage(`Connection to ${profile.name} succeeded.`);
	} catch (error) {
		vscode.window.showErrorMessage(`Connection test failed: ${errorMessage(error)}`);
	}
}

async function editConnection(context: vscode.ExtensionContext, provider: SftpFileSystemProvider, connections: ConnectionTreeProvider, profile: ConnectionProfile): Promise<void> {
	const remotePath = await ask('Remote folder', 'Example: /var/www', profile.remotePath);
	if (!remotePath?.startsWith('/')) { return; }
	const name = await ask('Connection name', 'Shown in Easy VPS and Explorer', profile.name);
	if (!name) { return; }
	profile.name = name;
	profile.remotePath = path.posix.normalize(remotePath);
	provider.disconnect(profile.id);
	await saveProfile(context, profile);
	connections.refresh();
	vscode.window.showInformationMessage(`${profile.name} was updated.`);
}

async function importSshConfig(context: vscode.ExtensionContext, connections: ConnectionTreeProvider): Promise<void> {
	let text: string;
	try {
		text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(expandHome('~/.ssh/config')))).toString('utf8');
	} catch {
		vscode.window.showInformationMessage('No ~/.ssh/config file was found.'); return;
	}
	const selected = await vscode.window.showQuickPick(
		parseSshConfig(text).map((profile) => ({ label: profile.name, description: `${profile.username}@${profile.host}`, profile })),
		{ placeHolder: 'Choose SSH hosts to import', canPickMany: true },
	);
	if (!selected?.length) { return; }
	for (const item of selected) { await saveProfile(context, item.profile); }
	connections.refresh();
	vscode.window.showInformationMessage(`Imported ${selected.length} SSH connection${selected.length === 1 ? '' : 's'}.`);
}

function parseSshConfig(text: string): ConnectionProfile[] {
	const profiles: ConnectionProfile[] = [];
	let current: Partial<ConnectionProfile> | undefined;
	const finish = () => {
		if (current?.name && current.host && current.username) {
			profiles.push({
				id: `ssh-${slug(current.name)}`, name: current.name, host: current.host, port: current.port ?? 22,
				username: current.username, remotePath: '/', authType: current.privateKeyPath ? 'privateKey' : 'password', privateKeyPath: current.privateKeyPath
			});
		}
	};
	for (const rawLine of text.split(/\r?\n/)) {
		const [key, ...rest] = rawLine.trim().split(/\s+/); const value = rest.join(' ');
		if (key?.toLowerCase() === 'host' && value && !value.includes('*')) { finish(); current = { name: value, host: value }; }
		else if (current && value) {
			switch (key?.toLowerCase()) {
				case 'hostname': current.host = value; break;
				case 'user': current.username = value; break;
				case 'port': current.port = Number(value); break;
				case 'identityfile': current.privateKeyPath = value; break;
			}
		}
	}
	finish(); return profiles;
}

class SftpFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
	private readonly connections = new Map<string, ActiveConnection>();
	private readonly reconnections = new Map<string, Promise<ActiveConnection>>();
	private readonly readSnapshots = new Map<string, { mtime: number; size: number }>();
	private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.changeEmitter.event;

	constructor(private readonly context: vscode.ExtensionContext) { }
	isConnected(authority: string): boolean { return this.connections.has(authority); }

	watch(): vscode.Disposable {
		// SFTP has no standard file-change notification protocol. Explorer refreshes after operations.
		return new vscode.Disposable(() => undefined);
	}

	async connect(profile: ConnectionProfile, password?: string): Promise<void> {
		this.disconnect(profile.id);
		const config = await createConnectConfig(this.context, profile, password);
		const connection = await openSftp(config);
		connection.client.on('error', (error) => {
			this.connections.delete(profile.id);
			vscode.window.showErrorMessage(`${profile.name} connection error: ${error.message}`);
		});
		connection.client.on('close', () => this.connections.delete(profile.id));
		this.connections.set(profile.id, connection);
		await this.stat(vscode.Uri.from({ scheme: SCHEME, authority: profile.id, path: profile.remotePath }));
	}

	disconnect(authority: string): void {
		const connection = this.connections.get(authority);
		this.connections.delete(authority);
		connection?.client.end();
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const stats = await sftpCall<Stats>(await this.sftp(uri), 'stat', uri.path);
		return toFileStat(stats);
	}

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		const sftp = await this.sftp(uri);
		const entries = await sftpCall<Array<{ filename: string; attrs: Stats }>>(sftp, 'readdir', uri.path);
		return Promise.all(entries
			.filter((entry) => entry.filename !== '.' && entry.filename !== '..')
			.map(async (entry): Promise<[string, vscode.FileType]> => {
				let type = toFileType(entry.attrs);
				if (type === vscode.FileType.SymbolicLink) {
					try {
						const target = await sftpCall<Stats>(sftp, 'stat', path.posix.join(uri.path, entry.filename));
						type |= toFileType(target);
					} catch { /* Broken links remain symbolic links. */ }
				}
				return [entry.filename, type];
			}));
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const sftp = await this.sftp(uri);
		const stats = await sftpCall<Stats>(sftp, 'stat', uri.path);
		const content = await sftpCall<Buffer>(sftp, 'readFile', uri.path);
		this.readSnapshots.set(uri.toString(), { mtime: stats.mtime, size: stats.size });
		return content;
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
		const snapshot = this.readSnapshots.get(uri.toString());
		if (snapshot && await this.exists(uri)) {
			const current = await sftpCall<Stats>(await this.sftp(uri), 'stat', uri.path);
			if (current.mtime !== snapshot.mtime || current.size !== snapshot.size) {
				const choice = await vscode.window.showWarningMessage(
					`${path.posix.basename(uri.path)} changed on the VPS after you opened it.`,
					{ modal: true, detail: 'Overwrite the newer remote version with your editor contents?' },
					'Overwrite',
				);
				if (choice !== 'Overwrite') {
					throw vscode.FileSystemError.Unavailable('Save cancelled because the remote file changed.');
				}
			}
		}
		if (!options.create || !options.overwrite) {
			const exists = await this.exists(uri);
			if (!options.create && !exists) {
				throw vscode.FileSystemError.FileNotFound(uri);
			}
			if (!options.overwrite && exists) {
				throw vscode.FileSystemError.FileExists(uri);
			}
		}
		await sftpCall<void>(await this.sftp(uri), 'writeFile', uri.path, Buffer.from(content));
		const updated = await sftpCall<Stats>(await this.sftp(uri), 'stat', uri.path);
		this.readSnapshots.set(uri.toString(), { mtime: updated.mtime, size: updated.size });
		this.changed(vscode.FileChangeType.Changed, uri);
	}

	async createDirectory(uri: vscode.Uri): Promise<void> {
		await sftpCall<void>(await this.sftp(uri), 'mkdir', uri.path);
		this.changed(vscode.FileChangeType.Created, uri);
	}

	async mode(uri: vscode.Uri): Promise<number> {
		return (await sftpCall<Stats>(await this.sftp(uri), 'stat', uri.path)).mode;
	}

	async chmod(uri: vscode.Uri, mode: number): Promise<void> {
		await sftpCall<void>(await this.sftp(uri), 'chmod', uri.path, mode);
		this.changed(vscode.FileChangeType.Changed, uri);
	}

	async search(root: vscode.Uri, query: string, token: vscode.CancellationToken): Promise<vscode.Uri[]> {
		const matches: vscode.Uri[] = [];
		const pending = [root];
		const needle = query.toLocaleLowerCase();
		while (pending.length > 0 && matches.length < 200 && !token.isCancellationRequested) {
			const directory = pending.pop();
			if (!directory) { break; }
			let entries: [string, vscode.FileType][];
			try {
				entries = await this.readDirectory(directory);
			} catch {
				continue; // Skip directories the SSH user cannot read.
			}
			for (const [name, type] of entries) {
				const child = vscode.Uri.joinPath(directory, name);
				if (name.toLocaleLowerCase().includes(needle)) { matches.push(child); }
				// Do not recursively follow symlinks: they can form cycles across the server.
				if ((type & vscode.FileType.Directory) !== 0 && (type & vscode.FileType.SymbolicLink) === 0) {
					pending.push(child);
				}
				if (matches.length >= 200 || token.isCancellationRequested) { break; }
			}
		}
		return matches;
	}

	async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
		const stats = await this.stat(uri);
		if (stats.type === vscode.FileType.Directory) {
			if (options.recursive) {
				await this.deleteDirectoryRecursively(uri);
			} else {
				await sftpCall<void>(await this.sftp(uri), 'rmdir', uri.path);
			}
		} else {
			await sftpCall<void>(await this.sftp(uri), 'unlink', uri.path);
		}
		this.changed(vscode.FileChangeType.Deleted, uri);
	}

	async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
		if (oldUri.authority !== newUri.authority) {
			throw vscode.FileSystemError.NoPermissions('Moving files between VPS connections is not supported.');
		}
		if (!options.overwrite && await this.exists(newUri)) {
			throw vscode.FileSystemError.FileExists(newUri);
		}
		if (options.overwrite && await this.exists(newUri)) {
			await this.delete(newUri, { recursive: true });
		}
		await sftpCall<void>(await this.sftp(oldUri), 'rename', oldUri.path, newUri.path);
		this.changeEmitter.fire([
			{ type: vscode.FileChangeType.Deleted, uri: oldUri },
			{ type: vscode.FileChangeType.Created, uri: newUri },
		]);
	}

	copy?(source: vscode.Uri, destination: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
		return this.copyItem(source, destination, options);
	}

	dispose(): void {
		for (const authority of this.connections.keys()) {
			this.disconnect(authority);
		}
		this.changeEmitter.dispose();
	}

	private async sftp(uri: vscode.Uri): Promise<SFTPWrapper> {
		const connection = this.connections.get(uri.authority);
		if (connection) {
			return connection.sftp;
		}

		const profile = getProfiles(this.context).find((item) => item.id === uri.authority);
		if (!profile) {
			throw vscode.FileSystemError.Unavailable('The saved VPS connection was not found.');
		}

		let reconnecting = this.reconnections.get(profile.id);
		if (!reconnecting) {
			reconnecting = (async () => {
				const password = profile.authType === 'password'
					? await this.context.secrets.get(secretKey(profile.id))
					: undefined;
				if (profile.authType === 'password' && !password) {
					throw vscode.FileSystemError.Unavailable(
						`${profile.name} needs its password again. Run “Easy VPS: Connect to VPS”.`,
					);
				}
				await this.connect(profile, password);
				const restored = this.connections.get(profile.id);
				if (!restored) {
					throw vscode.FileSystemError.Unavailable(`Could not restore ${profile.name}.`);
				}
				return restored;
			})();
			this.reconnections.set(profile.id, reconnecting);
			reconnecting.finally(() => this.reconnections.delete(profile.id));
		}
		return (await reconnecting).sftp;
	}

	private async exists(uri: vscode.Uri): Promise<boolean> {
		try {
			await this.stat(uri);
			return true;
		} catch (error) {
			if (isNotFound(error)) {
				return false;
			}
			throw error;
		}
	}

	private async deleteDirectoryRecursively(uri: vscode.Uri): Promise<void> {
		for (const [name, type] of await this.readDirectory(uri)) {
			const child = vscode.Uri.joinPath(uri, name);
			if (type === vscode.FileType.Directory) {
				await this.deleteDirectoryRecursively(child);
			} else {
				await sftpCall<void>(await this.sftp(child), 'unlink', child.path);
			}
		}
		await sftpCall<void>(await this.sftp(uri), 'rmdir', uri.path);
	}

	private async copyItem(source: vscode.Uri, destination: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
		if (source.authority !== destination.authority) {
			throw vscode.FileSystemError.NoPermissions('Copying between VPS connections is not supported yet.');
		}
		const sourceStat = await this.stat(source);
		if (sourceStat.type === vscode.FileType.Directory) {
			if (!await this.exists(destination)) {
				await this.createDirectory(destination);
			}
			for (const [name] of await this.readDirectory(source)) {
				await this.copyItem(vscode.Uri.joinPath(source, name), vscode.Uri.joinPath(destination, name), options);
			}
		} else {
			await this.writeFile(destination, await this.readFile(source), { create: true, overwrite: options.overwrite });
		}
	}

	private changed(type: vscode.FileChangeType, uri: vscode.Uri): void {
		this.changeEmitter.fire([
			{ type, uri },
			{ type: vscode.FileChangeType.Changed, uri: vscode.Uri.joinPath(uri, '..') },
		]);
	}
}

async function createConnectConfig(
	context: vscode.ExtensionContext,
	profile: ConnectionProfile,
	password?: string,
): Promise<ConnectConfig> {
	const config: ConnectConfig = {
		host: profile.host,
		port: profile.port,
		username: profile.username,
		readyTimeout: 20_000,
		keepaliveInterval: 15_000,
		keepaliveCountMax: 3,
	};
	if (profile.authType === 'password') {
		config.password = password;
	} else if (profile.privateKeyPath) {
		const keyUri = vscode.Uri.file(expandHome(profile.privateKeyPath));
		config.privateKey = Buffer.from(await vscode.workspace.fs.readFile(keyUri));
	}
	const hostId = `${profile.host}:${profile.port}`;
	const hostKeys = context.globalState.get<Record<string, string>>(HOST_KEYS_KEY, {});
	let trustedFingerprint = hostKeys[hostId];
	if (!trustedFingerprint) {
		const observed = await readHostFingerprint(config);
		const choice = await vscode.window.showWarningMessage(
			`First connection to ${hostId}. Verify its SSH host key fingerprint.`,
			{ modal: true, detail: `SHA256 fingerprint: ${observed}\n\nOnly trust this key if it belongs to your VPS.` },
			'Trust and Connect',
		);
		if (choice !== 'Trust and Connect') {
			throw new Error('SSH host key was not trusted.');
		}
		trustedFingerprint = observed;
		await context.globalState.update(HOST_KEYS_KEY, { ...hostKeys, [hostId]: observed });
	}
	config.hostHash = 'sha256';
	config.hostVerifier = (fingerprint: string) => fingerprint === trustedFingerprint;
	return config;
}

function readHostFingerprint(config: ConnectConfig): Promise<string> {
	return new Promise((resolve, reject) => {
		const client = new Client();
		let fingerprint: string | undefined;
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) { return; }
			settled = true;
			client.end();
			if (fingerprint) { resolve(fingerprint); }
			else { reject(error ?? new Error('The server did not provide an SSH host key.')); }
		};
		client.once('ready', () => finish());
		client.once('error', (error) => finish(error));
		client.connect({
			...config,
			hostHash: 'sha256',
			hostVerifier: (value: string) => {
				fingerprint = value;
				return false;
			},
		});
	});
}

function openSftp(config: ConnectConfig): Promise<ActiveConnection> {
	return new Promise((resolve, reject) => {
		const client = new Client();
		client.once('ready', () => {
			client.sftp((error, sftp) => {
				if (error) {
					client.end();
					reject(error);
				} else {
					resolve({ client, sftp });
				}
			});
		});
		client.once('error', reject);
		client.connect(config);
	});
}

function sftpCall<T>(sftp: SFTPWrapper, method: string, ...args: unknown[]): Promise<T> {
	return new Promise((resolve, reject) => {
		const callback = (error: Error | undefined | null, result: T) => {
			if (error) {
				reject(toFsError(error));
			} else {
				resolve(result);
			}
		};
		(sftp as unknown as Record<string, (...values: unknown[]) => void>)[method](...args, callback);
	});
}

function toFileStat(stats: Stats): vscode.FileStat {
	return {
		type: toFileType(stats),
		ctime: stats.atime * 1000,
		mtime: stats.mtime * 1000,
		size: stats.size,
		permissions: (stats.mode & 0o200) === 0 ? vscode.FilePermission.Readonly : undefined,
	};
}

function toFileType(stats: Stats): vscode.FileType {
	if (stats.isDirectory()) {
		return vscode.FileType.Directory;
	}
	if (stats.isSymbolicLink()) {
		return vscode.FileType.SymbolicLink;
	}
	return vscode.FileType.File;
}

function toFsError(error: Error & { code?: number | string }): Error {
	if (error.code === 2 || error.code === 'ENOENT') {
		return vscode.FileSystemError.FileNotFound(error.message);
	}
	if (error.code === 3 || error.code === 'EACCES') {
		return vscode.FileSystemError.NoPermissions(error.message);
	}
	return error;
}

function isNotFound(error: unknown): boolean {
	return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

function getProfiles(context: vscode.ExtensionContext): ConnectionProfile[] {
	return context.globalState.get<ConnectionProfile[]>(PROFILES_KEY, []);
}

async function saveProfile(context: vscode.ExtensionContext, profile: ConnectionProfile): Promise<void> {
	const profiles = getProfiles(context);
	const index = profiles.findIndex((item) => item.id === profile.id || sameServer(item, profile));
	if (index >= 0) {
		profile.id = profiles[index].id;
		profiles[index] = profile;
	} else {
		profiles.push(profile);
	}
	await context.globalState.update(PROFILES_KEY, profiles.filter((item, itemIndex) =>
		itemIndex === profiles.findIndex((candidate) => sameServer(candidate, item))));
}

function sameServer(left: ConnectionProfile, right: ConnectionProfile): boolean {
	return left.host.toLowerCase() === right.host.toLowerCase()
		&& left.port === right.port
		&& left.username === right.username;
}

function remoteWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
	return vscode.workspace.workspaceFolders?.filter((folder) => folder.uri.scheme === SCHEME) ?? [];
}

async function ask(
	prompt: string,
	placeHolder: string,
	value?: string,
	validateInput?: (value: string) => string | undefined,
): Promise<string | undefined> {
	return vscode.window.showInputBox({ prompt, placeHolder, value, ignoreFocusOut: true, validateInput });
}

function secretKey(id: string): string {
	return `easy-vps.password.${id}`;
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'vps';
}

function expandHome(filePath: string): string {
	if (filePath === '~') {
		return process.env.HOME ?? filePath;
	}
	if (filePath.startsWith('~/')) {
		return path.join(process.env.HOME ?? '', filePath.slice(2));
	}
	return filePath;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function deactivate(): void { }
