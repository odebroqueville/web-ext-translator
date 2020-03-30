// Modules to control application life and create native browser window
import { app, BrowserWindow, ipcMain, dialog, IpcMainEvent, BrowserView, FindInPageOptions } from "electron";
import path from "path";
import fs from "fs";
import fileUrl from "file-url";
import { WetSaveFilesEntry, WetLoadFilesResult } from "web-ext-translator-shared";

class SearchView {
    private static list: SearchView[] = [];

    public static fromBrowserWindow(window: BrowserWindow) {
        return SearchView.list.find(e => e.window === window) || null;
    }

    public static fromBrowserView(view: BrowserView) {
        return SearchView.list.find(e => e.view === view) || null;
    }

    private window: BrowserWindow;
    private view: BrowserView | null = null;
    public constructor(window: BrowserWindow) {
        this.window = window;
        SearchView.list.push(this);
        window.on("closed", this.onWindowClosed);
        window.on("resize", this.reposition);
        window.webContents.on("found-in-page", this.found);
    }

    private onWindowClosed = () => {
        this.window = null;
        this.view = null;
        SearchView.list = SearchView.list.filter(e => e !== this);
    };

    private reposition = () => {
        if (this.window && this.view) {
            const bounds = this.window.getContentBounds();
            const width = 400;
            const height = 35;
            this.view.setBounds({ x: 0, y: bounds.height - height, width, height });
        }
    };

    public show = () => {
        if (this.window && !this.view) {
            this.view = new BrowserView({
                webPreferences: {
                    contextIsolation: true,
                    enableRemoteModule: false,
                    preload: path.join(__dirname, "searchPreload.js")
                }
            });
            this.window.setBrowserView(this.view);
            this.view.webContents.loadFile(path.join(__dirname, "search.html"));
            this.reposition();
            this.view.webContents.focus();
        }
    };

    public hide = () => {
        if (this.window && this.view) {
            this.window.removeBrowserView(this.view);
            this.view = null;
            this.stopFindInPage('keepSelection');
        }
    };

    public findInPage(text: string, options?: FindInPageOptions) {
        if (this.window) {
            this.window.webContents.findInPage(text, options);
        }
    }
    public stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection') {
        this.window && this.window.webContents.stopFindInPage(action);
    }

    private found = (event: Electron.Event, result: Electron.Result) => {
        if (this.window && this.view) {
            this.view.webContents.send("update", result.activeMatchOrdinal, result.matches);
        }
    };
}

function createWindow(workingDirectory: string) {
    let win = new BrowserWindow({
        width: 800,
        height: 600,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            contextIsolation: true,
            enableRemoteModule: false,
            preload: path.join(__dirname, "preload.js")
        }
    });
    if (!app.commandLine.hasSwitch("debug")) win.setMenu(null);
    win.loadURL(fileUrl(path.join(__dirname, "docs", "index.html")) + "#" + workingDirectory);

    const searchView = new SearchView(win);
    win.on("closed", () => {
        win = null;
    });
}

app.whenReady().then(() => createWindow(process.cwd()));

app.on("window-all-closed", function() {
    process.platform !== "darwin" && app.quit();
});

app.on("activate", function() {
    BrowserWindow.getAllWindows().length === 0 && createWindow(process.cwd());
});

function on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void) {
    ipcMain.on(channel, (event, ...args) => {
        event.returnValue = listener(event, ...args);
    });
}

function onSearch(channel: string, listener: (search: SearchView, event: IpcMainEvent, ...args: any[]) => void) {
    on(channel, (event, ...args) => {
        const view = BrowserView.fromWebContents(event.sender);
        const search = SearchView.fromBrowserView(view);
        search && listener(search, event, ...args);
    })
}

onSearch("find-in-page", (search, event, text, options) => search.findInPage(text, options));
onSearch("stop-find-in-page", (search, event, action) => search.stopFindInPage(action));
onSearch("show-search", (search, event) => search.show());
onSearch("hide-search", (search, event) => search.hide());

on("close", event => {
    return (
        dialog.showMessageBoxSync({
            type: "question",
            title: "Files have not been saved",
            message: "There are unsaved changes. Discard these changes?",
            buttons: ["OK", "Cancel"],
            defaultId: 1,
            cancelId: 1
        }) === 0
    );
});

on("openDirectory", event => {
    dialog
        .showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
            properties: ["openDirectory"],
            title: "Select your Web Extension root directory"
        })
        .then(result => {
            if (!result.canceled && result.filePaths.length) createWindow(result.filePaths[0]);
        });
});

const isDirectory = (file: string) => fs.existsSync(file) && fs.lstatSync(file).isDirectory();
const isFile = (file: string) => fs.existsSync(file) && !fs.lstatSync(file).isDirectory();
const readFile = (file: string) => fs.readFileSync(file, "utf-8");

on(
    "loadFiles",
    (event, extDir): WetLoadFilesResult => {
        const localesDir = path.join(extDir, "_locales");
        const manifestFile = path.join(extDir, "manifest.json");
        if (isFile(manifestFile) && isDirectory(localesDir)) {
            try {
                const editorConfigsToLoad = new Set<string>();
                const locales = [];
                for (const localeDir of fs.readdirSync(localesDir)) {
                    const localePath = path.join(localesDir, localeDir);
                    if (!isDirectory(localePath)) continue;
                    const messagesPath = path.join(localePath, "messages.json");
                    if (isFile(messagesPath)) {
                        const editorConfigPaths = [
                            [".editorconfig"],
                            ["..", ".editorconfig"],
                            ["..", "..", ".editorconfig"]
                        ]
                            .map(paths => path.join(localePath, ...paths))
                            .filter(isFile);
                        editorConfigPaths.forEach(p => editorConfigsToLoad.add(p));
                        locales.push({
                            path: messagesPath,
                            data: readFile(messagesPath),
                            locale: localeDir.replace("_", "-"),
                            editorConfigs: editorConfigPaths
                        });
                    }
                }
                const editorConfigs = [...editorConfigsToLoad.values()].map(path => ({
                    path,
                    data: readFile(path)
                }));
                return {
                    locales,
                    manifest: {
                        path: manifestFile,
                        data: readFile(manifestFile)
                    },
                    editorConfigs
                };
            } catch (e) {
                return e.message;
            }
        }
        return "manifest.json or _locales directory missing";
    }
);

on("saveFiles", (event, extDir: string, files: WetSaveFilesEntry[]) => {
    const localesDir = path.join(extDir, "_locales");
    if (isDirectory(localesDir)) {
        try {
            for (const { locale, data } of files) {
                const dir = path.join(localesDir, locale.replace("-", "_"));
                if (!isDirectory(dir)) fs.mkdirSync(dir);
                const file = path.join(dir, "messages.json");
                fs.writeFileSync(file, data);
            }
            return null;
        } catch (e) {
            return e.message;
        }
    }
    return "Directory does not exist";
});
