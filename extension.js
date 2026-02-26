const util = require('util');
const exec = util.promisify(require('child_process').exec);
const spawn = require('child_process').spawn;
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const chokidar = require('chokidar');
const { LanguageClient } = require('vscode-languageclient/node');

const {Cscope,queryCscope,vscodeQuery} = require('./Tools/cscope');

const Client = require('ssh2-sftp-client')

// const FileExplorer = require('./Tools/Fileprovider').AixExplorerProvider; //Explorer to manage the files openes from the remote.
const AixFSProvider = require('./Tools/Fileprovider').AixFSProvider;  //FileManager that reads/write the file from th remote.

const hash_path = require('./Tools/Fileprovider').hash_path;



// Handling downtime and restart the servers
class ServerReload {
    constructor(context, restartFunc) {
        this.context = context;
        this.restartFunc = restartFunc;

        // load servers from state
        const stored = context.globalState.get("connectedServers") || [];
        this.servers = stored.map(obj => Server.fromJSON(obj));
    }

    getAll() {
        return this.servers;
    }

    async restartAll() {
        for (const server of this.servers) {
            const value = `${server.AIX_USER}@${server.AIX_HOST}:`;
            try {
                await this.restartFunc(this.context, value, server);
                console.log(`Restarted server ${value}`);
            } catch (err) {
                console.error(`Failed to restart ${value}`, err);
            }
        }
    }

    async add(server) {
        this.servers.push(server);
        await this.context.globalState.update(
            "connectedServers",
            this.servers.map(s => s.toJSON())
        );
    }

    async remove(server) {
        this.servers = this.servers.filter(
            s => !(s.AIX_USER === server.AIX_USER && s.AIX_HOST === server.AIX_HOST)
        );
        await this.context.globalState.update(
            "connectedServers",
            this.servers.map(s => s.toJSON())
        );
    }
}




// Global map to store all server instances
const Servers = new Map();   // Map to  map hostip id to the Server class
const Listeners = new Map(); // Map tp store the pythonlistener that I have created for each of the terminal to stop them at last
const uriLocaltoRemote = new Map(); // Map to store the local uri to remote uri.
const cclsclients = new Map(); // Map to store the ccls clients for each proj.


// common to all servers
let LOCAL_SYNC_DIR = ''; // My local dir where I am keeping the command
let mount_dir = ''; // My mount_Dir where all these servers dir will be placed.
let watcherScript = ''; // Watcherscript python which do the checking on command.txt
let safeCode ='';  // code to be pasted on the remote to make this code command work.
// let Explorer = null;

class Server
{
    constructor(LOCAL_COMMAND_FILE,AIX_HOST,AIX_USER,TEMP_DIR,Provider)
    {
        this.LOCAL_COMMAND_FILE = LOCAL_COMMAND_FILE;
        this.AIX_HOST = AIX_HOST;
        this.AIX_USER = AIX_USER;
        this.TEMP_DIR = TEMP_DIR;
        this.rsync_path = 'opt/freeware/bin/rsync';
        this.sed_path = '';
        this.ccls_path = '';
        this.osname = '';
        this.rtport = 0;
        this.localtoRemote = new Map();
        this._lastModified = new Map();
        this._lastModified_size = new Map();
        this.sftp = new Client();
        this.FS_Provider = Provider;
        this.localfoldertoRemote = new Map(); // Map to store the local folder to remote path files.

        
    }

    updateLocalToRemote(remotePath,fileName)
    {
        this.localtoRemote.set(fileName,remotePath);
        fs.writeFileSync(path.join(this.TEMP_DIR,`${this.AIX_HOST}_files.json`),JSON.stringify(this.localtoRemote));

    }

    // SetPort(port)
    // {
    //     this.port = port;
    // }

    CreatingTempDir()
    {
        fs.mkdirSync(this.TEMP_DIR, { recursive: true });
    }

    async Setkeypath(keyPath)
    {
        this.keyPath = keyPath;
        try {
        await this.sftp.connect({
            host: this.AIX_HOST,
            username: this.AIX_USER,
            privateKey: fs.readFileSync(this.keyPath)
        });

        vscode.window.showInformationMessage("SFTP connected successfully");
        } catch (err) {
            vscode.window.showErrorMessage(`SFTP connect failed: ${err.message}`);
            throw err;
        }
    }

    //   // --- NEW: serialize/deserialize helpers ---
    toJSON() {
        return {
            LOCAL_COMMAND_FILE: this.LOCAL_COMMAND_FILE,
            AIX_HOST: this.AIX_HOST,
            AIX_USER: this.AIX_USER,
            TEMP_DIR: this.TEMP_DIR,
            // port: this.port,
            keyPath: this.keyPath,
            localtoRemote: [...this.localtoRemote]
        };
    }

    static fromJSON(obj) {
        const s = new Server(obj.LOCAL_COMMAND_FILE, obj.AIX_HOST, obj.AIX_USER, obj.TEMP_DIR);
        // s.port = obj.port;
        s.keyPath = obj.keyPath;
        s.localtoRemote = new Map(obj.localtoRemote || []);
        return s;
    }
}




function activate(context) {

    let activeWatcher = null;

    const Explorer_watcher = vscode.workspace.createFileSystemWatcher("**/*");  //for when some local files are deleted

    // //Defining the custom file explorer to be run for the AIX
    // Explorer = new FileExplorer(getServer,AllServers);
    // vscode.window.createTreeView('AIX-explorer', { treeDataProvider: Explorer });

    // Defining the filesystem for the AIX
    const provider = new AixFSProvider(AllServers); // pass your server map


// fake aix schema so that I can create fake uri for things like peek definition/peek refrences etc in c / c++ code.

const virtualProvider = {
    provideTextDocumentContent: async (uri) => {


        const retieve_frag = new URLSearchParams(uri.fragment);
        const cscope_Dir = retieve_frag.get('cscope_rootdir');

        const remotepath = retieve_frag.get('path');

        vscode.window.showInformationMessage(`Fetching content for ${uri.path} from AIX server ${uri.authority}`);

        const localpath = uri.path; // gettting the local path to see if the file is already there.
        const local_uri = vscode.Uri.file(localpath);

        if(!uriLocaltoRemote.has(local_uri.toString()))
        {
        let aix_uri = vscode.Uri.from({
                scheme: "aix",
                authority: uri.authority,
                path: remotepath,
            });

         // Creating the fragment for the uri
        const frag = new URLSearchParams({
        cscope_dir: cscope_Dir,
        }).toString();


        aix_uri = aix_uri.with({fragment: frag});

        await  provider.readFile(aix_uri);


       
    //    await provider.readFile(aix_uri); // Ensure file is downloaded and stored locally

 
       
        // updating the uriLocaltoRemote map
        uriLocaltoRemote.set(local_uri.toString(),aix_uri);
    }

       vscode.workspace.openTextDocument(localpath); // Open the file in vscode
       const content = fs.readFileSync(localpath, 'utf8');
       return content;

    }
};


context.subscriptions.push(
  vscode.workspace.registerTextDocumentContentProvider("fake_aix", virtualProvider)
);

// // fucntiond for the new epxplorere
// context.subscriptions.push(
//     vscode.commands.registerCommand("OpenFile",async(file)=>
//     {
//         await Explorer.OpenFile(file);
//     }
// )
// );
//  👇 Register listener globally during activation, not inside a command
//     const open_document = vscode.workspace.onDidOpenTextDocument(async (document) => {
// //   if(!editor) return;

//         // const document = editor.document;

//         if(!document) return;

//         const uri = document.uri;

//         // if(uri.scheme === 'fake_aix')
//         // {
//         //     vscode.workspace.openTextDocument(uri.path);
//         //     vscode.window.showTextDocument(vscode.Uri.file(uri.path), { preview: true, preserveFocus: true });

//         // } 

//         const fragment = new URLSearchParams(uri.fragment)

//         if(fragment.get('cscope_rootdir'))
//         {

//             const cscope_Dir = fragment.get('cscope_rootdir');
//             const remote_path = fragment.get('path');

//             const server = fragment.get('authority');
//             let aix_uri = vscode.Uri.from({
//             scheme: "aix",
//             authority: server,
//             path: remote_path,
//             });

//                 // Creating the fragment for the uri
//             const frag = new URLSearchParams({
//             cscope_dir: cscope_Dir,
//             }).toString();

//             aix_uri = aix_uri.with({fragment: frag});

//             await provider.readFile(aix_uri);   // reading the file from the remote if not present locally.


//             vscode.window.showInformationMessage("Preview or open triggered");
           


//         const local_path = await hash_path(remote_path,Servers.get(server)); // gettting the local path to see if the file is already there.


//         const local_uri = vscode.Uri.file(local_path);
        
//         vscode.window.showInformationMessage(`URI: ${local_path}`);
 
//         await vscode.window.showTextDocument(local_uri); //showing the local file.

//         }

// });
const saving_Doc =  //Saving the files which will be done by my custom fs. 
 vscode.workspace.onDidSaveTextDocument(async (event) => {
    const local_uri = event.uri;

    const remote_uri = uriLocaltoRemote.get(local_uri.toString());  // as the local_uri has changed it doesn't have that fragment hence will not be able to find it.need to resolve this.

    if (!remote_uri) return; // not an AIX-mapped file

    console.log("Saving: " + local_uri.fsPath + " to " + remote_uri.path);
    await provider.writeFile(remote_uri, Buffer.from(event.getText()), {
        create: true,
        overwrite: true
    });
});

    const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor( async (editor) => {

        // console.log(' editor change')
        






        vscode.window.showInformationMessage("Active file changed");

        if (activeWatcher) {
            activeWatcher.dispose();
            activeWatcher = null;
        }

        const local_uri = editor?.document.uri;
        if (!local_uri) return;


        const remote_uri = uriLocaltoRemote.get(local_uri.toString());
        if (!remote_uri) return; // not an AIX-mapped file

        vscode.window.showInformationMessage("Yes it gonna watch u!!")
        activeWatcher = provider.watch(remote_uri);


        

    });



    // Setting up the command to search for the functions using cscope
    const def_search = vscode.languages.registerDefinitionProvider(['cpp','c'],{
        async provideDefinition(document, position, token) {
            const remote_uri = uriLocaltoRemote.get(document.uri.toString());
            if (!remote_uri) {
                return null; // Not a remote file, skip
            }
            const result = await vscodeQuery(provider,remote_uri,document,position,Servers,"define"); //provider is the class that do all backend work of file seinzing and other things.
            return result;
        }
        
});


    const def_refrence = vscode.languages.registerReferenceProvider(['cpp','c'],
        {
             async provideReferences(document, position, token) {
                const remote_uri = uriLocaltoRemote.get(document.uri.toString());
                if (!remote_uri) {
                    return null; // Not a remote file, skip
                }
                const result = await vscodeQuery(provider,remote_uri,document,position,Servers,"refrences");
                return result;
                
             }

        }
    );


    //To defined it globally so that disposable can use .
    const disposable = vscode.commands.registerCommand('remote-rsync.Remote-Rsync', async function () {
   
        // Creating an reload_Manager instance
        const reloadManager = new ServerReload(context, mountSSHFS);
        
        // Restart all servers on activation
        // reloadManager.restartAll().then(() => {
        //     console.log("All servers restarted");
        // }).catch(err => {
        //     console.error("Failed to restart servers:", err);
        // });
        
       //defining variables here
        let LOCAL_COMMAND_FILE = '';
        let AIX_USER = '';
        let AIX_HOST = '';
        let TEMP_DIR = '';


        // Check if workspace folder exists (Bob editor compatibility)
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('Please open a workspace folder first to use Remote-Rsync');
            return;
        }

        mount_dir = vscode.workspace.workspaceFolders[0].uri.fsPath;
        fs.mkdirSync(path.join(mount_dir, '.sshfs'), { recursive: true });
        LOCAL_SYNC_DIR = path.join(mount_dir, '.sshfs');
        


 const logins = loadconfig(context) || [];

let value = await new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick();

    quickPick.items = logins.map(login => ({ label: login }));
    quickPick.placeholder = 'Select a saved login or type a new one';
    quickPick.ignoreFocusOut = true;

    quickPick.onDidAccept(() => {
        const selectedValue =
            quickPick.selectedItems.length > 0
                ? quickPick.selectedItems[0].label
                : quickPick.value;

        quickPick.hide();
        quickPick.dispose();

        console.log("values",selectedValue);
        resolve(selectedValue ? selectedValue.trim() : undefined);
    });

    // quickPick.onDidHide(() => {
    //     quickPick.dispose();
    //     resolve(undefined);
    // });

    quickPick.show();
   
});


if (!value) return;

console.log("Selected login:", value);

        
        value = value.trim(); // removing unnecessary spaces
    console.log("Selected login:", value);

        // Validate format: user@host
        if (!value.includes('@')) {
            vscode.window.showErrorMessage('Invalid format. Please use: user@host');
            return;
        }

        [AIX_USER, AIX_HOST] = value.split('@');
        
        // Validate both parts exist
        if (!AIX_USER || !AIX_HOST) {
            vscode.window.showErrorMessage('Invalid format. Both username and hostname are required');
            return;
        }

        TEMP_DIR = path.join(mount_dir, `temp_${AIX_HOST}`);
        LOCAL_COMMAND_FILE = path.join(LOCAL_SYNC_DIR, `command_${AIX_HOST}.txt`);
        
        let Remote_server = new Server(LOCAL_COMMAND_FILE,AIX_HOST,AIX_USER,TEMP_DIR,provider);

        await mountSSHFS(context, value,Remote_server);  //Setting up the server


        fs.writeFileSync(LOCAL_COMMAND_FILE,'');

      
        Servers.set(AIX_HOST, Remote_server);
        // Explorer.refresh();

        // if (Remote_server.ccls_path !== '') 
        // {         
        //     const client = new LanguageClient(
        //                     "remote-ccls",
        //                     "Remote CCLS",
        //                     {
        //                         command: "node",
        //                         args: ["/Tools/lsp_proxy.js"],
        //                         options: { env: process.env }
        //                     },
        //                     {
        //                         documentSelector: [
        //                         { scheme: "file", language: "cpp" },
        //                         { scheme: "file", language: "c" }
        //                         ]
        //                     }
        //                     );
        //                     client.start();
        //  }



     
        reloadManager.add(Remote_server); // For reloading of the server when refresh or server is lost
        

        // Register the virtual file system provider for aix:
        // const provider = new AixFSProvider(AIX_USER, AIX_HOST, Remote_server.keyPath,TEMP_DIR);
        // context.subscriptions.push(
        //     vscode.workspace.registerFileSystemProvider(`aix_${AIX_HOST}`, provider, { isCaseSensitive: true })
        // );

        // for the case when we load the files from local temp
// vscode.workspace.onDidOpenTextDocument(async doc => {
//     const filePath = doc.uri.fsPath;

//     // Only intercept TEMP files, not VFS URIs
//     if (filePath.startsWith(TEMP_DIR)) {
//         const fileName = path.basename(filePath);
//         const remotePath = Remote_server.localtoRemote.get(fileName);
//         const vfsUri = vscode.Uri.parse(`aix_${AIX_HOST}:${remotePath}`);

//         // Defer to let VSCode finish opening first
//        setTimeout(async () => {
//     // Find the editor showing this TEMP file
//     const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === filePath);
//     if (editor) {
//         await vscode.window.showTextDocument(editor.document); // make it active
//         await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
//     }

//     // Now open the VFS one
//     const file = await vscode.workspace.openTextDocument(vfsUri);
//     await vscode.window.showTextDocument(file, { preview: true, preserveFocus: false });
// }, 50);

//     }
// });



    //Running watch from custom AIXfs to see any updates from remote to local  

// Opening the file from the local editor

// vscode.workspace.onDidOpenTextDocument((doc) => {
//     const remote_uri = uriLocaltoRemote.get(doc.uri.toString());
//     if (!remote_uri) return;

//     const key = remote_uri.toString();
//     if (!watchers.has(key)) {
//         const watcher = (remote_uri);
//         watchers.set(key, watcher);
//     }
// });


// Closing the listener who's terminal have stopped and they have nothing to do.
vscode.window.onDidCloseTerminal((closedTerm) => {
    const proc = Listeners.get(closedTerm);
    if (proc) {
        proc.kill(); // stop python listener
        Listeners.delete(closedTerm);
    }
});


// Clean up when doc is closed
// vscode.workspace.onDidCloseTextDocument((doc) => {
//     const local_uri = doc.uri;
//     const remote_uri = uriLocaltoRemote.get(local_uri.toString());

//     const key = remote_uri.toString();

//     watchers.get(key)?.dispose();

//     watchers.delete(key);
    
//     // if (doc.uri.toString() === local_uri.toString()) {
//     //     watchers.delete(key);
//     // }
// });

// vscode.window.onDidChangeActiveTextEditor((editor) => {
//     // Dispose previous watcher

//     vscode.window.showInformationMessage("Active file changed");

//     if (activeWatcher) {
//         activeWatcher.dispose();
//         activeWatcher = null;
//     }

//     const local_uri = editor?.document.uri;
//     if (!local_uri) return;

//     const remote_uri = uriLocaltoRemote.get(local_uri.toString());
//     if (!remote_uri) return; // not an AIX-mapped file

//     // Create a new watcher for the currently active file
//     activeWatcher = provider.watch(remote_uri);
// });







        watchCommandFile(Remote_server);
    });



// Local files are deleted and we have to remove the cache of the aixfs
// let FS_Explorer=  Explorer_watcher.onDidDelete(async uri => {

//     const remote_uri = uriLocaltoRemote.has(uri.toString());
//     if (remote_uri) {
//         console.log("Local file deleted, clearing cache:", uri.fsPath);
//         uriLocaltoRemote.delete(uri.toString());
//     }

//     const remote_doc = vscode.window.visibleTextEditors.find(
//         editor => editor.document.uri.toString() === uri.toString()
//     );

//       if (remote_doc) {
//         console.log("Closing deleted file:", uri.fsPath);
//         await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
//     }


// });

    let Terminal_loader = vscode.commands.registerCommand("AIX_Terminals", async function() {
    // Turn the Servers map into QuickPick items
    const term_quickPickItems = Array.from(Servers.entries()).map(([host, server]) => ({
        label: host,   // shown in QuickPick
        description: server.TEMP_DIR || '' // optional: show extra info
    }));

    if (term_quickPickItems.length === 0) {
        vscode.window.showErrorMessage("No active servers available");
        return;
    }

    const selected = await vscode.window.showQuickPick(term_quickPickItems, {
        placeHolder: 'Select a connected server',
        ignoreFocusOut: true
    });
    if (!selected) return;

    const chosenHost = selected.label;
    const chosenServer = Servers.get(chosenHost);

    vscode.window.showInformationMessage(chosenHost," ");

    if (!chosenServer) {
        vscode.window.showErrorMessage(`No active server found for ${chosenHost}`);
        return;
    }

    Boot(`${chosenServer.AIX_USER}@${chosenHost}`, chosenServer);
});

    context.subscriptions.push(editorChangeDisposable);
    context.subscriptions.push(disposable);
    context.subscriptions.push(Terminal_loader);
    context.subscriptions.push(def_search);
    context.subscriptions.push(saving_Doc);
    // context.subscriptions.push(open_document);
    context.subscriptions.push(def_refrence);
    // context.subscriptions.push(FS_Explorer);
}



// function to getorcreate the ccls client per project
async function getorstartcclsclient(Remote_Server,remote_dir)
{
    if(cclsclients.has(remote_dir))
    {
        return cclsclients.get(remote_dir);
    }
    if(Remote_Server.ccls_path === '')
   { 
    Remote_Server.ccls_path = '/Kushal/lsp/ccls/Release/ccls';  // default path if not found
    }// to make sure ccls path is set

    vscode.window.showInformationMessage(`Starting ccls for project: ${remote_dir}`);
    const client = new LanguageClient(
    `ccls-${remote_dir}`,
    `ccls (${remote_dir})`,
    {
      command: `ssh`,
      args: [`${Remote_Server.AIX_USER}@${Remote_Server.AIX_HOST}`,`${Remote_Server.ccls_path}`],
      options: {
        env:process.env }
    },
    {
      documentSelector: [
        { scheme: 'file', language: 'cpp'},
        { scheme: 'file', language: 'c'}
      ]
      ,
       traceOutputChannel: vscode.window.createOutputChannel('ccls-trace'),
    }
  );
  client.traceOutputChannel.show(true);
  client.start();
  cclsclients.set(remote_dir, client);
  return client;
}


// Dynamically assoscaiting the file explorer with the new servers
async function getServer()
{
    return  Array.from(Servers.entries()).map(([hostname,Remote_server])=>
        ( 
            {
                "name": hostname,
                "folder": Remote_server.TEMP_DIR,
            }
        )
    );
}
//Returning all the Server map
async function AllServers()
{
    return Servers;
}


function watchCommandFile(Remote_server) {

    chokidar.watch(Remote_server.LOCAL_COMMAND_FILE).on('change', () => {
        let target = fs.readFileSync(Remote_server.LOCAL_COMMAND_FILE, 'utf8').trim();
        let remote_dir = '';
        let newtarget = '';
        if(target && target.includes('::'))
        {
            const parts = target.split('::');
            if (parts.length >= 2) {
                newtarget = parts[1].trim();
                remote_dir = parts[0].trim();
                pullFromAix(newtarget,Remote_server,remote_dir);
                // getorstartcclsclient(Remote_server,remote_dir);
                // Cscope(Remote_server,remote_dir);
            }
        }
        else if (target) {
            pullFromAix(target,Remote_server);
        }
    });
}



// remote_dir is needed to see where that cscope_dir has been stored by the package.
async function pullFromAix(remotePath,Remote_server,remote_dir="") {
    remotePath = path.posix.normalize(remotePath);
    // Explorer.refresh();

    
    
    // fs.writeFileSync(path.join(Remote_server.TEMP_DIR,`${Remote_server.AIX_HOST}_files.json`),JSON.stringify(Remote_server.localtoRemote));

      let uri = vscode.Uri.from({
                scheme: "aix",
                authority: Remote_server.AIX_HOST,
                path: remotePath,
            });

        const localFile = await hash_path(remotePath,Remote_server);


        // Remote_server.updateLocalToRemote(path.basename(remotePath),remotePath); 

        // Creating the fragment for the uri
        const frag = new URLSearchParams({
        cscope_dir: remote_dir,
        server: Remote_server // storing this remote_server so that ccls can get the approach to run the commands later.
        }).toString();

        uri = uri.with({ fragment: frag });  // Setting up the uri for the files to be get the cscope_dir later when needed.
        // setting up the local uri
        let local_uri = vscode.Uri.file(localFile);
        // local_uri = local_uri.with({fragment: frag});
        
        let local_file=null;
        if(uriLocaltoRemote.get(local_uri.toString()))
        {
            local_file = await vscode.workspace.openTextDocument(local_uri);
        }
        else
        {
           uriLocaltoRemote.set(local_uri.toString(),uri);

            await Remote_server.FS_Provider.readFile(uri);
            local_file = await vscode.workspace.openTextDocument(local_uri);
        }

    
        try{
            
            await vscode.window.showTextDocument(local_file, { preview: true, preserveFocus: true });
        }
        catch (err) {
            if(err.message.includes("Failed to reload: CodeExpectedError: cannot open file"))
            {
                await vscode.commands.executeCommand('vscode.open',local_uri);
            }
        }

  
    
}

function saveConfig(context, login) {
    const configPath = vscode.Uri.joinPath(context.globalStorageUri, 'sshfs-config.json').fsPath;
    vscode.window.showInformationMessage(`Saving login: ${configPath}`);
    let logins = [];
    if (fs.existsSync(configPath)) {
        try { logins = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
    }
    if (!logins.includes(login)) logins.push(login);
    if(!fs.existsSync(context.globalStorageUri.fsPath))
    {fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });}
    fs.writeFileSync(configPath, JSON.stringify(logins, null, 2));
}

function loadconfig(context) {
    const configPath = vscode.Uri.joinPath(context.globalStorageUri, 'sshfs-config.json').fsPath;
    if (fs.existsSync(configPath)) {
        try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return []; }
    }
    return [];
}

function startWatcher(watcherScript,Remote_server) {
    return new Promise((resolve, reject) => {
        fs.chmodSync(watcherScript, "755");

        const pyProc = spawn("python3", [watcherScript,path.join(LOCAL_SYNC_DIR,`command_${Remote_server.AIX_HOST}.txt`)], {
            detached: true,   // allows it to keep running in background
            stdio: ["ignore", "pipe", "pipe"]
        });


        let port;

        pyProc.stdout.on("data", data => {
            const output = data.toString().trim();
            const parsedPort = parseInt(output, 10);

            if (!isNaN(parsedPort)) {
                port = parsedPort;
                console.log("Watcher assigned PORT:", port);
                resolve({ port, process: pyProc });
            }
        });

        pyProc.stderr.on("data", err => {
            console.error(`Watcher error: ${err}`);
        });

        pyProc.on("error", reject);

        // Don't tie Node's lifecycle to the child
        pyProc.unref();
    });
}


function TerminalLoader(userHost,Remote_server,Pyproc,Remote_server_port)
{
     // Create (or reuse) a VS Code terminal
        const terminal = vscode.window.createTerminal({ name: `${Remote_server.AIX_HOST}_Terminal` });

        terminal.show();

        // Send reverse SSH tunnel command
        const forwardCmd = `ssh -R ${Remote_server_port}:localhost:${Remote_server_port}  \
  -o StrictHostKeyChecking=no \
  -o ServerAliveInterval=10 -o ServerAliveCountMax=3 ${userHost}`;
        terminal.sendText(forwardCmd, true);

        // Storing the terminal sessions listener so that if close the terminal remove those listeners
        Listeners.set(terminal, Pyproc);

}


// function to find the path of the different tools on the remote aix server

function ToolPath(Remote_server,tool)
{
    return new Promise((resolve, reject) => {

        let default_path = '';

        if(Remote_server.osname === "AIX")
        {
            default_path = '/opt/freeware/bin';
        }
        else if(Remote_server.osname === "Linux")
        {
            default_path = '/usr/bin';
        }
        const whichRsync = spawn("ssh", [`${Remote_server.AIX_USER}@${Remote_server.AIX_HOST}`, `which ${tool}`]);

        
        let toolPath = "";
        let stderr = "";
        whichRsync.stdout.on('data', (data) => {
            toolPath = data.toString();
            // Now ru
        });

        whichRsync.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        whichRsync.on('close', (code) => {
            if(code !== 0) {
                let foundit = false;
                if(toolPath === "")
                {
                  let Path= spawn("ssh", [`${Remote_server.AIX_USER}@${Remote_server.AIX_HOST}`, `find ${default_path} -name ${tool} | head -n 1`]);
                  Path.stdout.on('data', (data) => {
                    toolPath = data.toString();
                    // Now ru
                });

                 Path.stderr.on('data', (data) => {
                    stderr += data.toString();
                });

                Path.on('close', (code) => {
                    if(code !== 0)
                    {
                        vscode.window.showErrorMessage(`Error finding ${tool}`);
                    reject(new Error(`Error: No such file or directory: ${stderr}`));
                    }
                    else{
                        foundit = true;
                        resolve(toolPath);
                        console.log(`${tool} path set to: ${toolPath}`);
                    }
                });
                }

                if(!foundit)
                {
                    vscode.window.showErrorMessage(`Error finding ${tool}`);
                    reject(new Error(`Error: No such file or directory: ${stderr}`));
                }
            }

            toolPath = toolPath.split('\n').find(p => p.trim().endsWith(`${tool}`)) || '';
                if (toolPath ) {
                    if(tool === 'rsync')  
                        {
                            Remote_server.rsync_path = toolPath.trim();
                            resolve(Remote_server.rsync_path);
                            console.log(`${tool} path set to: ${Remote_server.rsync_path}`);
                        }  
                        else if(tool === 'sed'){
                            toolPath = toolPath.trim();
                            Remote_server.sed_path = toolPath;
                            resolve(toolPath);
                            console.log(`${tool} path set to: ${toolPath}`);

                        }    
                        else if (tool === 'ccls'){
                            toolPath = toolPath.trim();
                            Remote_server.ccls_path = toolPath;
                            resolve(toolPath);
                            console.log(`${tool} path ccls to: ${toolPath}`);
                        }

                        

                } else {
                    console.warn(`${tool} not found on remote, using default`);
                    resolve("");
                }

        });

    });

}



async function Boot(userHost,Remote_server) {
    try {
        // Start your watcher
        const { port, process: pyProc } = await startWatcher(watcherScript,Remote_server);

        console.log("Now safe to continue. Using port:", port);

        // setting port to the Remote_server class
        Remote_server.rtport = port;

      
        // Replace placeholder with port
        let finalSafeCode = safeCode.replace('VS_PORT', port);

        // Build SSH heredoc
const sshCmd = `
ssh -o StrictHostKeyChecking=no ${userHost} 'bash -s' <<'EOF'
if grep '^[[:space:]]*code[[:space:]]*\(\)[[:space:]]*{' "$HOME/.bashrc"; then
    ${Remote_server.sed_path} -i '/^[[:space:]]*code[[:space:]]*\(\)[[:space:]]*{/,/^[[:space:]]*}/d' "$HOME/.bashrc"
fi
cat <<'EOC' >> "$HOME/.bashrc"
${finalSafeCode}
EOC
EOF`;

        // Execute the heredoc injection
        await exec(sshCmd,{env: process.env}); // so that at the remote we pass all SSH_AUTH_SOCK env etc to get agent forwarding.


      
        

        //Creat the terminal for reverse tunnel
        TerminalLoader(userHost,Remote_server,process,port);
       
        console.log("Boot sequence finished.");
    } catch (err) {
        console.error("Failed to start Boot:", err);
        throw err;
    }
}




async function mountSSHFS(context, value,Remote_server) {
    const [userHost, remotePath = '/'] = value.split(':');

    // checking if the server exists or not.
try {
    // -o BatchMode=yes prevents asking password
    // -o ConnectTimeout=5 sets timeout in seconds
    await exec(`ssh -o BatchMode=yes -o ConnectTimeout=5 ${value} "exit"`);  //now here it will come out of that proc and will proceed further
    vscode.window.showInformationMessage("✅ Connection successful!");
} catch (err) {
    if (err.message.includes("Could not resolve hostname")) {
        vscode.window.showErrorMessage("❌ Invalid hostname!");
        return;
    }
    // if (err.message.includes("Permission denied")) {
    //     vscode.window.showWarningMessage("⚠️ Host exists, but authentication failed!");
    //     return;
    // }
    if (err.message.includes("Connection timed out")) {
        vscode.window.showErrorMessage("❌ Host unreachable (timeout)");
        return;
    }
    vscode.window.showErrorMessage("❌ Connection failed: " + err.message);
}




    // Get home directory with fallback for different platforms
    const homeDir = process.env.HOME || process.env.USERPROFILE || require('os').homedir();
    let keyPath = `${homeDir}/.ssh/id_rsa_${Remote_server.AIX_HOST}`;






    const code_bash = fs.readFileSync(path.join(__dirname, 'code.sh'), 'utf8');
    safeCode = code_bash
        .replace(/"/g, '\"')
        .replace(/'/g, "\'")
        .replace(/\$/g, '\$');

    // Always prompt for password if key exists but remote access fails
    let needKeyInstall = false;
    // Try a test SSH connection using the key
        vscode.window.showInformationMessage(`Connecting  ${fs.existsSync(keyPath)} to ${value}...`);


    if (fs.existsSync(keyPath)) {
        try {
            await exec(`ssh -i ${keyPath} -o BatchMode=yes -o StrictHostKeyChecking=no ${userHost} "echo connected"`);
            console.log('SSH key works, no need to reinstall'); 
        } catch (err) {
        vscode.window.showErrorMessage(`Initial SSH connection failed:`);

            // If permission denied, we need to reinstall the key
            if (/Permission denied/.test(err.stderr || err.message)) {
                console.log('SSH key did not work, will reinstall');
                await exec(`yes y | ssh-keygen -t rsa -b 4096 -f ${keyPath} -N ""`);
                needKeyInstall = true;
            }
        }
    } else {
        vscode.window.showInformationMessage(`Connecting  ${keyPath} to ${value}...`);
        await exec(`yes y | ssh-keygen -t rsa -b 4096 -f ${keyPath} -N ""`);
        needKeyInstall = true;
    }

    let password = '';

    if(needKeyInstall ) {
        vscode.window.showErrorMessage(`Initial SSH connection failed:`);

    password = await vscode.window.showInputBox({
        prompt: `Enter password for ${userHost}`,
        password: true,
        ignoreFocusOut: true
    });
    if (!password) return;
}


    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Mounting ${value}...` },
        async () => {
            try {
                if (needKeyInstall) {
                    // Optionally, regenerate the key if you want to always refresh
                    // await exec(`ssh-keygen -t rsa -b 4096 -f ${keyPath} -N ""`);

                    await runExpect(userHost, keyPath, password);
                    vscode.window.showInformationMessage(`SSH key copied to ${userHost}`);
                } else {
                    vscode.window.showInformationMessage(`SSH key already exists at ${keyPath} and works`);
                }

                watcherScript = path.join(__dirname, 'socket_watcher.py');  //initialising the connection to listen to the port from remote-aix.
                if (!fs.existsSync(watcherScript)) {
                    vscode.window.showErrorMessage('Watcher script not found');
                    return;
                }


                   // If config exists, check contents creating the connection so that we don't need to do handshake again and again.

                const sshConfigEntry = `
Host ${Remote_server.AIX_HOST}
    HostName ${Remote_server.AIX_HOST}
    User ${Remote_server.AIX_USER}
    IdentityFile ${keyPath}
    StrictHostKeyChecking no
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 10m
`;



                   const sshConfigPath = path.join(process.env.HOME ,"/.ssh/config");
                if (fs.existsSync(sshConfigPath)) {
                    const existingConfig = fs.readFileSync(sshConfigPath, "utf8");
                    const safeHost = Remote_server.AIX_HOST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    const safeKeyPath = keyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

                    const blockRegex = new RegExp(
                    String.raw`Host\s+${safeHost}\s*` +
                    String.raw`\n\s*HostName\s+${safeHost}\s*` +
                    String.raw`\n\s*User\s+${Remote_server.AIX_USER}\s*` +
                    String.raw`\n\s*IdentityFile\s+${safeKeyPath}\s*`,
                    "m"
                    );
                    if (blockRegex.test(existingConfig)) {
                        console.log(`SSH config for ${Remote_server.AIX_HOST} already exists, skipping append.`);
                       
                    }
                    else{
                        fs.appendFileSync(sshConfigPath, sshConfigEntry, { encoding: "utf8" });
                        console.log(`SSH config for ${Remote_server.AIX_HOST} added.`);
                    }
                }
                else{
                    fs.writeFileSync(sshConfigPath, sshConfigEntry, { encoding: "utf8" });
                    console.log(`SSH config file created and entry for ${Remote_server.AIX_HOST} added.`);
                }

                // Setting up the key now starting a sftp connection
                Remote_server.Setkeypath(keyPath);

                // Append if not found

                // See the OS what kind of os it is
                const oscmd = `ssh -o StrictHostKeyChecking=no ${userHost} 'uname -s'`;

                const {stdout: osstring}= await exec(oscmd,{encoding:"utf8"});

                Remote_server.osname = osstring.toString("utf8").trim();


               
                await Boot(userHost,Remote_server);


                                  //Setting up the rsync path
                await ToolPath(Remote_server,"rsync");

                //Setting up the sed path
                await ToolPath(Remote_server,"sed");

                 try{
                // Setting up the ccls path
                await ToolPath(Remote_server,"ccls");

               
                if(Remote_server.ccls_path !== '')
                {
                     spawn("ssh", [`${Remote_server.AIX_USER}@${Remote_server.AIX_HOST}`,`${Remote_server.ccls_path} --port=${Remote_server.rtport}`]);
                }
            }                catch(err)
            {
                console.warn("Failed to start ccls:", err.message);
            }
  
                //setting up the base setup 
                saveConfig(context, value);
             
                // creating temp dir for this server
                Remote_server.CreatingTempDir();

                // vscode.window.showInformationMessage(`Mounted: ${value}`);
            } catch (err) {
                vscode.window.showErrorMessage(`Mount failed: ${err.message}`);
                return;
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
            if (code === 0) resolve();
            else if (code === 1) {
                console.warn('Expect exited with code 1 — likely key already exists, continuing...');
                resolve();
            } else reject(new Error(`Expect failed with code ${code}`));
        });
    });
}

function deactivate() {
    for (const [host, server] of Servers) {
    try {
        fs.rmSync(server.TEMP_DIR, { recursive: true, force: true });
        console.log(`Temp folder ${server.TEMP_DIR} deleted`);
    } catch (err) {
        console.error(`Failed to delete temp folder: ${err.message}`);
    }
}

for (const [terminal, pyproc] of Listeners) {
    console.log(" closingLS")
    if (pyproc) {
        pyproc.kill();
    }
}

uriLocaltoRemote.clear();
Servers.clear();
Listeners.clear();

}

module.exports = { activate, deactivate };
