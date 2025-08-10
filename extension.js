const util = require('util');
const exec = util.promisify(require('child_process').exec);
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
let config='';
let Open_files ={};

function activate(context) {
    const terminal = vscode.window.createTerminal('Rsync Mount');
    terminal.show();

    const disposable = vscode.commands.registerCommand('remote-rsync.helloWorld', async function () {
        const folder = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Open Folder'
        });
        if (!folder) {
            vscode.window.showErrorMessage('No folder selected for mounting');
            return;
        }

        mount_dir = folder[0].fsPath;
        fs.mkdirSync(path.join(mount_dir, '.sshfs'), { recursive: true });
        LOCAL_SYNC_DIR = path.join(mount_dir, '.sshfs');

        const logins = loadconfig(context) || [];
        const quickPickItems = [...logins.map(login => ({ label: login })), { label: 'Enter new login', alwaysShow: true }];
        const selected = await vscode.window.showQuickPick(quickPickItems, { placeHolder: 'Select a saved login or enter a new one' });
        if (!selected) return;

        let value = selected.label;
        if (value === 'Enter new login') {
            const input = await vscode.window.showInputBox({ prompt: 'Enter username@ip_address:/' });
            if (!input) return;
            value = input;
        }

        [AIX_USER, AIX_HOST] = value.split('@');
        await mountSSHFS(context, value, mount_dir);
        watchCommandFile();
    });

    context.subscriptions.push(disposable);
}

function watchCommandFile() {
    LOCAL_COMMAND_FILE = path.join(LOCAL_SYNC_DIR, 'command.txt');
    
    
    chokidar.watch(LOCAL_COMMAND_FILE).on('change', () => {
        const target = fs.readFileSync(LOCAL_COMMAND_FILE, 'utf8').trim();
        if (target) pullFromAix(target);
    });

    

    // vscode.workspace.onDidSaveTextDocument((doc) => {
    //     vscode.window.showInformationMessage(`File saved: ${doc.fileName}. ${syncedFilePath ? 'Syncing...' : ''}`);
    //     console.log(`File saved: ${doc.fileName}`);

    //     if (syncedFilePath && doc.fileName === syncedFilePath) {
    //         console.log(`File ${doc.fileName} is synced, pushing to AIX...`);
    //         vscode.window.showInformationMessage(`File saved: ${doc.fileName}`);
    //         pushToAix(target);
    //     }
    // });
}

async function pullFromAix(remotePath) {
    const filename = path.basename(remotePath);
    if (!Open_files.FILES) {
    Open_files.FILES = {};
    }
    Open_files.FILES[filename] = remotePath;

    Open_files['aix_user'] = AIX_USER;
    Open_files['aix_host'] = AIX_HOST;

    fs.writeFileSync(mount_dir+'/aix_config.json',JSON.stringify(Open_files,null,2), 'utf8');

    const localPath = path.join(mount_dir, filename);
    const remoteFull = `${AIX_USER}@${AIX_HOST}:${remotePath}`;
    const rsyncCmd = `rsync -avz -e "ssh -i ${keyPath}" ${remoteFull} ${mount_dir}`;
    try {
        await exec(rsyncCmd);
        syncedFilePath = localPath;
        exec(`code "${syncedFilePath}"`); // no need to await here
    } catch (err) {
        console.error(`Pull failed: ${err}`);
    }
}

// function pushToAix(filePath) {
//     if (!filePath) return;
//     const remoteTarget = `${AIX_USER}@${AIX_HOST}:${path.basename(filePath)}`;
//     const rsyncCmd = `rsync -avz -e "ssh -i ${keyPath}" "${filePath}" ${remoteTarget}`;
//     exec(rsyncCmd).catch(err => console.error(`Push failed: ${err}`));
// }

function saveConfig(context, login) {
    const configPath = vscode.Uri.joinPath(context.globalStorageUri, 'sshfs-config.json').fsPath;
    let logins = [];
    if (fs.existsSync(configPath)) {
        try { logins = JSON.parse(fs.readFileSync(configPath, 'utf8')); config= logins[0] } catch {}
    }
    
    if (!logins.includes(login)) logins.push(login);
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(logins, null, 2));
}

function loadconfig(context) {
    const configPath = vscode.Uri.joinPath(context.globalStorageUri, 'sshfs-config.json').fsPath;
    if (fs.existsSync(configPath)) {
        try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return []; }
    }
    return [];
}

async function mountSSHFS(context, value, mount_dir) {
    const [userHost, remotePath = '/'] = value.split(':');
    keyPath = `${process.env.HOME}/.ssh/id_rsa_${AIX_HOST}`;
    const pubKeyPath = `${keyPath}.pub`;
    const code_bash = fs.readFileSync(path.join(__dirname, 'code.sh'), 'utf8');
    const safeCode = code_bash
        .replace(/"/g, '\"') // Escape double quotes
        .replace(/'/g, "\'") // Escape single quotes
        .replace(/\$/g, '\$');  // Escape dollar signs


    // Generate key if not exists
    if (!fs.existsSync(keyPath)) {
        await exec(`ssh-keygen -t rsa -b 4096 -f ${keyPath} -N ""`);
    }

    // Ask for password
    const password = await vscode.window.showInputBox({
        prompt: `Enter password for ${userHost}`,
        password: true
    });
    if (!password) return;

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Mounting ${value}...` },
        async () => {
            try {
                // Step 1: Run expect to copy SSH key
                await runExpect(userHost, keyPath, password);
                vscode.window.showInformationMessage(`SSH key copied to ${userHost}`);

                // Step 2: Create remote .sshfs dir and command.txt
                const mkdirCmd = `ssh -i ${keyPath} -o StrictHostKeyChecking=no ${userHost} 'bash -s' <<'EOF'
                mkdir -p ~/.sshfs
                > ~/.sshfs/command.txt
                echo pkgs.txt >> ~/.sshfs/command.txt
                > ~/.bashrc
                cat <<'EOC' >> ~/.bashrc
                ${safeCode}`;

                 await exec(mkdirCmd);

                // Step 3: Start watcher.py
                const watcherScript = path.join(__dirname, 'watcher.py');
                if (!fs.existsSync(watcherScript)) {
                    vscode.window.showErrorMessage('Watcher script not found');
                    return;
                }
                fs.chmodSync(watcherScript, '755');
                const pyProc = spawn('python3', [watcherScript, AIX_USER, AIX_HOST, keyPath,LOCAL_SYNC_DIR]);
                pyProc.stdout.on('data', data => console.log(`Watcher: ${data}`));
                pyProc.stderr.on('data', err => console.error(`Watcher error: ${err}`));

                // Step 4: Save config
                saveConfig(context, value);

                // Step 5: Open VS Code in mount dir
                try {
                    // await exec(`code --folder-uri "${mount_dir}"`);
                    const helperPath = "/Users/kushalverma/Documents/AIX/Extension/helper";
                    await exec(`code --extensionDevelopmentPath="${helperPath}" "${mount_dir}"`);

                } catch (err) {
                    vscode.window.showErrorMessage(`Failed to open VS Code in ${mount_dir}`);
                }

                vscode.window.showInformationMessage(`Mounted: ${value}`);
            } catch (err) {
                vscode.window.showErrorMessage(`Mount failed: ${err.message}`);
            }
        }
    );
}

function runExpect(userHost, keyPath, password) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, 'expect.sh');
        const child = spawn('expect', [scriptPath, userHost, keyPath, password]);

        child.stdout.on('data', data => console.log(`expect: ${data}`));
        child.stderr.on('data', data => console.error(`expect error: ${data}`));

        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else if (code === 1) {
                console.warn('Expect exited with code 1 — likely key already exists, continuing...');
                resolve(); // Treat as success
            } else {
                reject(new Error(`Expect failed with code ${code}`));
            }
        });
    });
}


function deactivate() {
    if (syncedFilePath && fs.existsSync(syncedFilePath)) {
        fs.unlinkSync(syncedFilePath);
    }
}

module.exports = { activate, deactivate };
