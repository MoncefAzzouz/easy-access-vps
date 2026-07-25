# Easy VPS

Browse and edit files on a VPS directly in the VS Code Explorer over SSH/SFTP.

## Features

- Connect using an SSH private key or password.
- Open a remote folder in the standard VS Code Explorer.
- Read, edit, create, rename, copy, move, and delete remote files and folders.
- Reuse saved connection profiles.
- Store passwords in VS Code Secret Storage, never in settings or profile data.

## Run the extension

1. Run `npm install` in this directory.
2. Open this directory in VS Code.
3. Press `F5` to open an Extension Development Host.
4. In the new window, click the remote icon in the Explorer toolbar or run **Easy VPS: Connect to VPS** from the Command Palette.
5. Enter the host, SSH port, username, remote folder, and authentication method.

The selected remote folder appears in Explorer as a workspace folder.

## Security

SSH keys are recommended. Passwords are kept in VS Code's encrypted Secret Storage. Connection metadata (host, username, port, remote path, and private-key path) is saved globally so a connection can be selected again.

Easy VPS currently uses the SSH library's default host-key handling. Before publishing this extension for production use, add known-host verification and an explicit first-connection fingerprint confirmation flow.

## Current limitations

- SFTP does not provide standard live file watching, so changes made outside VS Code may require refreshing Explorer.
- Copying or moving files between two different VPS connections is not supported.
- This extension provides file access only; it does not run terminals, debuggers, or language servers on the VPS.
