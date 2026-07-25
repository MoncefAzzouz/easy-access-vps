import * as path from 'node:path';
import { Client, ConnectConfig, SFTPWrapper, Stats } from 'ssh2';
import * as vscode from 'vscode';

const SCHEME = 'easy-vps';
const PROFILES_KEY = 'easy-vps.profiles';
type AuthType = 'password' | 'privateKey';

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
	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider(SCHEME, provider, {
			isCaseSensitive: true,
			isReadonly: false,
		}),
		vscode.commands.registerCommand('easy-vps.connect', () => connectToVps(context, provider)),
		vscode.commands.registerCommand('easy-vps.disconnect', () => disconnectFromVps(provider)),
		vscode.commands.registerCommand('easy-vps.forgetConnection', () => forgetConnection(context, provider)),
		provider,
	);
}

async function connectToVps(
	context: vscode.ExtensionContext,
	provider: SftpFileSystemProvider,
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
				const uri = vscode.Uri.from({ scheme: SCHEME, authority: profile.id, path: profile.remotePath });
				const existing = vscode.workspace.workspaceFolders?.find((folder) => folder.uri.toString() === uri.toString());
				if (!existing) {
					vscode.workspace.updateWorkspaceFolders(
						vscode.workspace.workspaceFolders?.length ?? 0,
						0,
						{ uri, name: profile.name },
					);
				}
				vscode.window.showInformationMessage(`${profile.name} is available in Explorer.`);
			} catch (error) {
				provider.disconnect(profile.id);
				vscode.window.showErrorMessage(`Could not connect to ${profile.name}: ${errorMessage(error)}`);
			}
		},
	);
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
): Promise<void> {
	const profiles = getProfiles(context);
	const selected = await vscode.window.showQuickPick(
		profiles.map((profile) => ({ label: profile.name, description: `${profile.username}@${profile.host}`, profile })),
		{ placeHolder: 'Forget which saved connection?' },
	);
	if (!selected) {
		return;
	}
	provider.disconnect(selected.profile.id);
	await context.secrets.delete(secretKey(selected.profile.id));
	await context.globalState.update(PROFILES_KEY, profiles.filter((item) => item.id !== selected.profile.id));
	for (const folder of remoteWorkspaceFolders().filter((item) => item.uri.authority === selected.profile.id)) {
		const index = vscode.workspace.workspaceFolders?.indexOf(folder);
		if (index !== undefined && index >= 0) {
			vscode.workspace.updateWorkspaceFolders(index, 1);
		}
	}
}

class SftpFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
	private readonly connections = new Map<string, ActiveConnection>();
	private readonly reconnections = new Map<string, Promise<ActiveConnection>>();
	private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.changeEmitter.event;

	constructor(private readonly context: vscode.ExtensionContext) {}

	watch(): vscode.Disposable {
		// SFTP has no standard file-change notification protocol. Explorer refreshes after operations.
		return new vscode.Disposable(() => undefined);
	}

	async connect(profile: ConnectionProfile, password?: string): Promise<void> {
		this.disconnect(profile.id);
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
		const entries = await sftpCall<Array<{ filename: string; attrs: Stats }>>(await this.sftp(uri), 'readdir', uri.path);
		return entries
			.filter((entry) => entry.filename !== '.' && entry.filename !== '..')
			.map((entry) => [entry.filename, toFileType(entry.attrs)]);
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		return sftpCall<Buffer>(await this.sftp(uri), 'readFile', uri.path);
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
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
		this.changed(vscode.FileChangeType.Changed, uri);
	}

	async createDirectory(uri: vscode.Uri): Promise<void> {
		await sftpCall<void>(await this.sftp(uri), 'mkdir', uri.path);
		this.changed(vscode.FileChangeType.Created, uri);
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
	const index = profiles.findIndex((item) => item.id === profile.id);
	if (index >= 0) {
		profiles[index] = profile;
	} else {
		profiles.push(profile);
	}
	await context.globalState.update(PROFILES_KEY, profiles);
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

export function deactivate(): void {}
