// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
// const vscode = require('vscode');

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

// /**
//  * @param {vscode.ExtensionContext} context
//  */
// // This is your updated extension.js with full integration of command.txt watcher and rsync syncing

const exec  = require('child_process').exec;
const spawn = require('child_process').spawn;
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const chokidar = require('chokidar');

let syncedFilePath = null;
let LOCAL_COMMAND_FILE = '';
let LOCAL_SYNC_DIR = '';
let AIX_USER = '';
let AIX_HOST = '';
let mount_dir = '';
let keyPath = '';

function activate(context) {
    
    const terminal = vscode.window.createTerminal('Rsync Mount');
    terminal.show();

    const disposable = vscode.commands.registerCommand('remote-rsync.helloWorld', async function () {
        vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Open Folder'
        }).then(folder => {
            if (!folder) {
                vscode.window.showErrorMessage('No folder selected for mounting');
                return;
            }

			// Making the command.txt file
			mount_dir = folder[0].fsPath;
			fs.mkdirSync(path.join(mount_dir, '.sshfs'), { recursive: true });
			LOCAL_SYNC_DIR = path.join(mount_dir, '.sshfs');

            const logins = loadconfig(context) || [];
            let quickPickItems = logins.map(login => ({ label: login }));
            quickPickItems.push({ label: 'Enter new login', alwaysShow: true });    

            vscode.window.showQuickPick(quickPickItems, {
                placeHolder: 'Select a saved login or enter a new one'
            }).then(selected => {
                if (!selected) return;
                if (selected.label === 'Enter new login') {
                    vscode.window.showInputBox({prompt:'Enter username@ip_address:/'})
                        .then(value => { if (value) {
					AIX_USER = value.split("@")[0];
					AIX_HOST = value.split("@")[1].split(":")[0];
					mountSSHFS(context, value, mount_dir);
				}});
                } else {
                    mountSSHFS(context, selected.label, mount_dir);
                }
            });
        });
    });
    context.subscriptions.push(disposable);
    watchCommandFile();
}

function watchCommandFile() {
    // fs.mkdirSync(LOCAL_SYNC_DIR, { recursive: true });
	let target = '';

	LOCAL_COMMAND_FILE = path.join(LOCAL_SYNC_DIR, 'command.txt');
    chokidar.watch(LOCAL_COMMAND_FILE).on('change', () => {
        target = fs.readFileSync(LOCAL_COMMAND_FILE, 'utf8').trim();
        if (target) pullFromAix(target);
    });

    vscode.workspace.onDidSaveTextDocument((doc) => {
        if (syncedFilePath && doc.fileName === syncedFilePath) pushToAix(target);
    });
}

function pullFromAix(remotePath) {
    const filename = path.basename(remotePath);
    const localPath = path.join(mount_dir, filename);
    const remoteFull = `${AIX_USER}@${AIX_HOST}:${remotePath}`;
    const rsyncCmd = `rsync -avz -e "ssh -i ${keyPath}" ${remoteFull} ${mount_dir}`;
    exec(rsyncCmd, (err) => {
        if (!err) {
            syncedFilePath = localPath;
            exec(`code "${syncedFilePath}"`);
        }
    });
}

function pushToAix(remotePath) {
    if (!syncedFilePath) return;
    const remoteTarget = `${AIX_USER}@${AIX_HOST}:${remotePath}`;
    const rsyncCmd = `rsync -avz -e "ssh -i ${keyPath}" "${syncedFilePath}" ${remoteTarget}`;
    exec(rsyncCmd);
}

function saveConfig(context, login) {
    const configPath = vscode.Uri.joinPath(context.globalStorageUri, 'sshfs-config.json').fsPath;
    let logins = [];
    if (fs.existsSync(configPath)) {
        try { logins = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) {}
    }
    if (!logins.includes(login)) logins.push(login);
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(logins, null, 2));
}

function loadconfig(context) {
    const configPath = vscode.Uri.joinPath(context.globalStorageUri, 'sshfs-config.json').fsPath;
    if (fs.existsSync(configPath)) {
        try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { return []; }
    }
    return [];
}

function mountSSHFS(context, value, mount_dir) {
    const [userHost, remotePath = '/'] = value.split(':');
     keyPath = `${process.env.HOME}/.ssh/id_rsa_${AIX_HOST}`;

	const code_bash = fs.readFileSync(path.join(__dirname, 'code.sh'), 'utf8');

    const pubKeyPath = `${keyPath}.pub`;

    // If key doesn't exist, generate it first
    if (!fs.existsSync(keyPath)) {
        exec(`ssh-keygen -t rsa -b 4096 -f ${keyPath} -N ""`);
    }

    const remote = `${userHost}:/.sshfs`;

    vscode.window.showInputBox({ prompt: `Enter password for ${userHost}`, password: true })
        .then(password => {
            if (!password) return;

            vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Mounting ${value}...` }, async () => {
                return new Promise((resolve) => {

                    // Step 1: Copy the public key
                    const scriptPath = path.join(__dirname, 'expect.exp');
					const child = spawn('expect', [scriptPath, userHost, keyPath, password]);

					child.stdout.on('data', (data) => {
						console.log(`stdout: ${data}`);
					});

					child.stderr.on('data', (data) => {
						console.error(`stderr: ${data}`);
					});

					child.on('close', (code) => {
						if (code === 0) {
							vscode.window.showInformationMessage(`SSH key copied to ${userHost}`);
						} else {
							vscode.window.showErrorMessage(`Failed to copy SSH key (exit code: ${code})`);
						}
					});

					// Opening the vscode window
					const Open_dir = `code --folder-uri ${mount_dir}`;
					exec(Open_dir, (err) => {
						if (err) {
							vscode.window.showErrorMessage(`Failed to open VS Code in ${mount_dir}`);		
							return resolve();
						}
					});

                        // Step 2: Run mkdir on remote
                        const mkdirCmd = `ssh -i ${keyPath} -o StrictHostKeyChecking=no ${userHost} "mkdir -p ~/.sshfs && touch ~/.sshfs/command.txt && echo '${code_bash}' >> ~/.sshfs/command.txt"`;
                        exec(mkdirCmd, (err) => {
                            if (err) {
                                vscode.window.showErrorMessage(`Failed to create folder on ${userHost}`);
                                return resolve();
                            }
						
						// Starting the watcher/updater for command.txt
						const watcherScript = path.join(__dirname, 'watcher.py');
						if (fs.existsSync(watcherScript)) {
							fs.chmodSync(watcherScript, '755');
						} else {
							vscode.window.showErrorMessage('Watcher script not found');
							return resolve();
						}

						const pyProc = spawn('python3', [watcherScript, AIX_USER, AIX_HOST, LOCAL_SYNC_DIR, keyPath]);
						pyProc.stdout.on('data', data => console.log(`Watcher: ${data}`));
						pyProc.stderr.on('data', err => console.error(`Watcher error: ${err}`));

                            // Step 3: Save login and open parent dir
                            vscode.window.showInformationMessage(`Mounted: ${value}`);
                            saveConfig(context, value);
                            exec(`dirname "${mount_dir}"`, (err, stdout) => {
                                if (!err) {
                                    const parentDir = stdout.trim();
                                    exec(`cd "${parentDir}" && code .`);
                                }
                            });
                            resolve();
                        });
                    });
                });
            });
}

function unmountSSHFS(mount_dir){
    const script = path.join(__dirname, 'unmount.sh');
    if (fs.existsSync(script)) {
        fs.chmodSync(script, '755');
        exec(`bash "${script}" ${mount_dir}`, (err, stdout, stderr) => {
            if (err) vscode.window.showErrorMessage(`Unmount script failed: ${stderr}`);
            else vscode.window.showInformationMessage(`Unmounted: ${stdout}`);
        });
    }
}


function deactivate() {
    if (syncedFilePath && fs.existsSync(syncedFilePath)) {
        fs.unlinkSync(syncedFilePath);
    }
}

module.exports = {
    activate,
    deactivate
};

