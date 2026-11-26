#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface SmacWebView : WKWebView
@end

@implementation SmacWebView

- (void)captureNativeDragPasteboard:(id<NSDraggingInfo>)sender {
    NSPasteboard *pb = [sender draggingPasteboard];
    if (!pb) return;
    NSArray<NSURL *> *urls = [pb readObjectsForClasses:@[[NSURL class]]
                                               options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}];
    if (!urls || urls.count == 0) return;
    NSMutableArray<NSString *> *paths = [NSMutableArray arrayWithCapacity:urls.count];
    for (NSURL *u in urls) {
        if (u.isFileURL && u.path.length > 0) {
            [paths addObject:u.path];
        }
    }
    if (paths.count == 0) return;
    NSData *jsonData = [NSJSONSerialization dataWithJSONObject:paths options:0 error:nil];
    if (!jsonData) return;
    NSString *jsonStr = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    if (!jsonStr) return;
    NSString *js = [NSString stringWithFormat:@"window.__smacNativeDragPaths = %@; window.__smacNativeDragAt = Date.now();", jsonStr];
    [self evaluateJavaScript:js completionHandler:nil];
}

- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)sender {
    [self captureNativeDragPasteboard:sender];
    return [super draggingEntered:sender];
}

- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender {
    [self captureNativeDragPasteboard:sender];
    return [super performDragOperation:sender];
}

@end

@interface SmacAppDelegate : NSObject <NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, NSWindowDelegate>
@property (strong, nonatomic) NSWindow *mainWindow;
@property (strong, nonatomic) WKWebView *webView;
@property (strong, nonatomic) NSMutableArray<NSWindow *> *popupWindows;
@property (copy, nonatomic) NSString *appMode;
@property (copy, nonatomic) NSString *appTitle;
@property (copy, nonatomic) NSString *appTag;
@property (assign, nonatomic) int basePort;
@property (assign, nonatomic) int activePort;
@end

@implementation SmacAppDelegate

- (void)setupEnvironmentPath {
    NSString *home = NSHomeDirectory();
    NSMutableArray<NSString *> *extra = [NSMutableArray arrayWithObjects:
        @"/opt/homebrew/bin",
        @"/opt/homebrew/sbin",
        @"/usr/local/bin",
        @"/usr/local/sbin",
        [home stringByAppendingPathComponent:@".local/bin"],
        nil];

    NSString *nvmVerDir = [home stringByAppendingPathComponent:@".nvm/versions/node"];
    NSFileManager *fm = [NSFileManager defaultManager];
    BOOL isDir = NO;
    if ([fm fileExistsAtPath:nvmVerDir isDirectory:&isDir] && isDir) {
        NSArray<NSString *> *vers = [[fm contentsOfDirectoryAtPath:nvmVerDir error:nil]
            sortedArrayUsingSelector:@selector(localizedStandardCompare:)];
        if (vers.count > 0) {
            NSString *latestBin = [[nvmVerDir stringByAppendingPathComponent:vers.lastObject]
                stringByAppendingPathComponent:@"bin"];
            [extra insertObject:latestBin atIndex:0];
        }
    }

    NSString *curPath = [[[NSProcessInfo processInfo] environment] objectForKey:@"PATH"] ?: @"/usr/bin:/bin:/usr/sbin:/sbin";
    NSString *newPath = [[extra componentsJoinedByString:@":"] stringByAppendingFormat:@":%@", curPath];
    setenv("PATH", [newPath UTF8String], 1);
}

- (NSString *)findNodeExecutable {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *pathEnv = [NSString stringWithUTF8String:getenv("PATH") ?: ""];
    for (NSString *dir in [pathEnv componentsSeparatedByString:@":"]) {
        if (dir.length == 0) continue;
        NSString *cand = [dir stringByAppendingPathComponent:@"node"];
        if ([fm isExecutableFileAtPath:cand]) return cand;
    }
    NSArray<NSString *> *fallbacks = @[
        @"/opt/homebrew/bin/node",
        @"/usr/local/bin/node"
    ];
    for (NSString *f in fallbacks) {
        if ([fm isExecutableFileAtPath:f]) return f;
    }
    return nil;
}

- (BOOL)checkHealthOnPort:(int)port {
    if (port <= 0) return NO;
    NSString *urlStr = [NSString stringWithFormat:@"http://127.0.0.1:%d/api/health", port];
    NSURL *url = [NSURL URLWithString:urlStr];
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url
                                                       cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                                   timeoutInterval:1.0];
    NSURLResponse *resp = nil;
    NSError *err = nil;
    #pragma clang diagnostic push
    #pragma clang diagnostic ignored "-Wdeprecated-declarations"
    NSData *data = [NSURLConnection sendSynchronousRequest:req returningResponse:&resp error:&err];
    #pragma clang diagnostic pop
    if (!data || err) return NO;
    NSString *body = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!body) return NO;
    NSString *needle = [NSString stringWithFormat:@"\"%@\"", self.appTag];
    return [body rangeOfString:needle].location != NSNotFound;
}

- (int)findRunningPort {
    BOOL isGuest = [self.appMode isEqualToString:@"guest"];
    NSString *dataDir = [NSHomeDirectory() stringByAppendingPathComponent:(isGuest ? @".smac-guest" : @".smac")];
    NSString *portFile = [dataDir stringByAppendingPathComponent:(isGuest ? @"guest-web-port" : @"web-port")];
    NSString *portText = [NSString stringWithContentsOfFile:portFile encoding:NSUTF8StringEncoding error:nil];
    if (portText) {
        int p = [[portText stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] intValue];
        if (p > 0 && [self checkHealthOnPort:p]) return p;
    }
    for (int p = self.basePort; p <= self.basePort + 6; p++) {
        if ([self checkHealthOnPort:p]) return p;
    }
    return 0;
}

- (NSString *)resolveServerScriptPath {
    NSFileManager *fm = [NSFileManager defaultManager];
    BOOL isGuest = [self.appMode isEqualToString:@"guest"];
    NSString *resAppDir = [[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:@"app"];

    if (isGuest) {
        NSString *guestHomeDir = [NSHomeDirectory() stringByAppendingPathComponent:@".smac-guest"];
        NSString *guestHomeScript = [guestHomeDir stringByAppendingPathComponent:@"guest-server.js"];
        NSString *bundledGuestDir = [resAppDir stringByAppendingPathComponent:@"guest"];
        if (![fm fileExistsAtPath:guestHomeScript] && [fm fileExistsAtPath:[bundledGuestDir stringByAppendingPathComponent:@"guest-server.js"]]) {
            [fm createDirectoryAtPath:guestHomeDir withIntermediateDirectories:YES attributes:nil error:nil];
            for (NSString *f in [fm contentsOfDirectoryAtPath:bundledGuestDir error:nil]) {
                NSString *src = [bundledGuestDir stringByAppendingPathComponent:f];
                NSString *dst = [guestHomeDir stringByAppendingPathComponent:f];
                [fm removeItemAtPath:dst error:nil];
                [fm copyItemAtPath:src toPath:dst error:nil];
            }
        }
        if ([fm fileExistsAtPath:guestHomeScript]) return guestHomeScript;
        NSString *bundledScript = [bundledGuestDir stringByAppendingPathComponent:@"guest-server.js"];
        if ([fm fileExistsAtPath:bundledScript]) return bundledScript;
        NSString *localSmacGuest = [NSHomeDirectory() stringByAppendingPathComponent:@"smac/guest/guest-server.js"];
        if ([fm fileExistsAtPath:localSmacGuest]) return localSmacGuest;
    } else {
        NSString *localSmacHost = [NSHomeDirectory() stringByAppendingPathComponent:@"smac/web/server.js"];
        if ([fm fileExistsAtPath:localSmacHost]) return localSmacHost;
        NSString *bundledHost = [resAppDir stringByAppendingPathComponent:@"web/server.js"];
        if ([fm fileExistsAtPath:bundledHost]) return bundledHost;
    }
    return nil;
}

- (void)startBackendAndLoadUI {
    int existingPort = [self findRunningPort];
    if (existingPort > 0) {
        self.activePort = existingPort;
        NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%d/", existingPort]];
        [self.webView loadRequest:[NSURLRequest requestWithURL:url]];
        return;
    }

    NSString *splashHtml = [NSString stringWithFormat:
        @"<!DOCTYPE html><html><head><meta charset='utf-8'>"
        "<style>body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;"
        "background:#0b0f19;color:#e6edf7;font-family:-apple-system,BlinkMacSystemFont,sans-serif;}"
        ".spin{width:36px;height:36px;border:3px solid rgba(56,189,248,0.2);border-top-color:#38bdf8;border-radius:50%%;"
        "animation:s 0.8s linear infinite;margin-bottom:16px;}@keyframes s{to{transform:rotate(360deg)}}</style></head>"
        "<body><div class='spin'></div><div style='font-size:15px;font-weight:600;'>正在启动 %@…</div></body></html>",
        self.appTitle];
    [self.webView loadHTMLString:splashHtml baseURL:nil];

    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        NSString *nodePath = [self findNodeExecutable];
        NSString *scriptPath = [self resolveServerScriptPath];
        if (!nodePath || !scriptPath) {
            dispatch_async(dispatch_get_main_queue(), ^{
                NSString *msg = !nodePath
                    ? @"未检测到 Node.js 环境，请先安装 Node.js (brew install node 或 https://nodejs.org)。"
                    : @"未找到内置控制台服务脚本。";
                NSAlert *alert = [[NSAlert alloc] init];
                alert.messageText = self.appTitle;
                alert.informativeText = msg;
                [alert runModal];
            });
            return;
        }

        NSTask *task = [[NSTask alloc] init];
        task.launchPath = nodePath;
        task.arguments = @[scriptPath];
        task.currentDirectoryPath = [scriptPath stringByDeletingLastPathComponent];
        task.standardOutput = [NSFileHandle fileHandleWithNullDevice];
        task.standardError = [NSFileHandle fileHandleWithNullDevice];
        @try {
            [task launch];
        } @catch (NSException *ex) { }

        int readyPort = 0;
        for (int i = 0; i < 45; i++) {
            [NSThread sleepForTimeInterval:0.15];
            readyPort = [self findRunningPort];
            if (readyPort > 0) break;
        }

        dispatch_async(dispatch_get_main_queue(), ^{
            if (readyPort > 0) {
                self.activePort = readyPort;
                NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%d/", readyPort]];
                [self.webView loadRequest:[NSURLRequest requestWithURL:url]];
            } else {
                NSAlert *alert = [[NSAlert alloc] init];
                alert.messageText = self.appTitle;
                alert.informativeText = @"后台服务启动超时，请检查端口或 Node.js 环境。";
                [alert runModal];
            }
        });
    });
}

- (void)buildMenuBar {
    NSMenu *menubar = [[NSMenu alloc] init];
    NSMenuItem *appMenuItem = [[NSMenuItem alloc] init];
    [menubar addItem:appMenuItem];
    [NSApp setMainMenu:menubar];

    NSMenu *appMenu = [[NSMenu alloc] initWithTitle:self.appTitle];
    [appMenu addItemWithTitle:[NSString stringWithFormat:@"重新加载 %@", self.appTitle]
                       action:@selector(reloadPage:)
                keyEquivalent:@"r"];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:[NSString stringWithFormat:@"隐藏 %@", self.appTitle]
                       action:@selector(hide:)
                keyEquivalent:@"h"];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:[NSString stringWithFormat:@"退出 %@", self.appTitle]
                       action:@selector(terminate:)
                keyEquivalent:@"q"];
    [appMenuItem setSubmenu:appMenu];

    NSMenuItem *editMenuItem = [[NSMenuItem alloc] init];
    [menubar addItem:editMenuItem];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"编辑"];
    [editMenu addItemWithTitle:@"撤销" action:@selector(undo:) keyEquivalent:@"z"];
    [editMenu addItemWithTitle:@"重做" action:@selector(redo:) keyEquivalent:@"Z"];
    [editMenu addItem:[NSMenuItem separatorItem]];
    [editMenu addItemWithTitle:@"剪切" action:@selector(cut:) keyEquivalent:@"x"];
    [editMenu addItemWithTitle:@"复制" action:@selector(copy:) keyEquivalent:@"c"];
    [editMenu addItemWithTitle:@"粘贴" action:@selector(paste:) keyEquivalent:@"v"];
    [editMenu addItemWithTitle:@"全选" action:@selector(selectAll:) keyEquivalent:@"a"];
    [editMenuItem setSubmenu:editMenu];

    NSMenuItem *winMenuItem = [[NSMenuItem alloc] init];
    [menubar addItem:winMenuItem];
    NSMenu *winMenu = [[NSMenu alloc] initWithTitle:@"窗口"];
    [winMenu addItemWithTitle:@"最小化" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
    [winMenu addItemWithTitle:@"关闭窗口" action:@selector(performClose:) keyEquivalent:@"w"];
    [winMenuItem setSubmenu:winMenu];
}

- (void)reloadPage:(id)sender {
    if (self.activePort > 0) {
        [self.webView reload];
    } else {
        [self startBackendAndLoadUI];
    }
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [self setupEnvironmentPath];
    self.popupWindows = [NSMutableArray array];

    NSDictionary *info = [[NSBundle mainBundle] infoDictionary];
    NSString *mode = [info objectForKey:@"SmacAppMode"] ?: @"host";
    self.appMode = [mode lowercaseString];
    BOOL isGuest = [self.appMode isEqualToString:@"guest"];
    self.appTitle = isGuest ? @"smac 客机控制台" : @"smac 主机控制台";
    self.appTag = isGuest ? @"smac-guest" : @"smac";
    self.basePort = isGuest ? 8790 : 8788;

    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [self buildMenuBar];

    CGFloat width = isGuest ? 1260 : 1380;
    CGFloat height = isGuest ? 860 : 880;
    NSRect frame = NSMakeRect(0, 0, width, height);
    NSUInteger style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;

    self.mainWindow = [[NSWindow alloc] initWithContentRect:frame
                                                  styleMask:style
                                                    backing:NSBackingStoreBuffered
                                                      defer:NO];
    self.mainWindow.title = self.appTitle;
    self.mainWindow.releasedWhenClosed = NO;
    self.mainWindow.delegate = self;
    if (@available(macOS 10.14, *)) {
        self.mainWindow.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    }
    self.mainWindow.backgroundColor = [NSColor colorWithCalibratedRed:0.043 green:0.059 blue:0.098 alpha:1.0];
    [self.mainWindow center];

    WKWebViewConfiguration *cfg = [[WKWebViewConfiguration alloc] init];
    [cfg.preferences setValue:@YES forKey:@"developerExtrasEnabled"];
    self.webView = [[SmacWebView alloc] initWithFrame:((NSView *)self.mainWindow.contentView).bounds configuration:cfg];
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.webView.UIDelegate = self;
    self.webView.navigationDelegate = self;
    if (@available(macOS 12.0, *)) {
        self.webView.underPageBackgroundColor = [NSColor colorWithCalibratedRed:0.043 green:0.059 blue:0.098 alpha:1.0];
    }
    [self.mainWindow.contentView addSubview:self.webView];

    [self.mainWindow makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];

    [self startBackendAndLoadUI];
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)theApplication hasVisibleWindows:(BOOL)flag {
    if (!flag && self.mainWindow) {
        [self.mainWindow makeKeyAndOrderFront:nil];
    }
    [NSApp activateIgnoringOtherApps:YES];
    return YES;
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return NO;
}

// ---------- WKNavigationDelegate (Download & External URL handling) ----------

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = navigationAction.request.URL;
    if (!url) {
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }
    if (url.isFileURL) {
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }
    NSString *host = [url.host lowercaseString] ?: @"";
    NSString *path = url.path ?: @"";

    // Handle Guest package ZIP download directly to ~/Downloads/smac-guest-setup.zip
    if ([path isEqualToString:@"/api/guest/package"]) {
        decisionHandler(WKNavigationActionPolicyCancel);
        dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
            NSData *zipData = [NSData dataWithContentsOfURL:url];
            dispatch_async(dispatch_get_main_queue(), ^{
                if (zipData && zipData.length > 0) {
                    NSString *downloads = [NSHomeDirectory() stringByAppendingPathComponent:@"Downloads"];
                    [[NSFileManager defaultManager] createDirectoryAtPath:downloads withIntermediateDirectories:YES attributes:nil error:nil];
                    NSString *destPath = [downloads stringByAppendingPathComponent:@"smac-guest-setup.zip"];
                    [zipData writeToFile:destPath atomically:YES];
                    NSURL *fileUrl = [NSURL fileURLWithPath:destPath];
                    [[NSWorkspace sharedWorkspace] activateFileViewerSelectingURLs:@[fileUrl]];
                }
            });
        });
        return;
    }

    if (([url.scheme isEqualToString:@"http"] || [url.scheme isEqualToString:@"https"]) &&
        ![host isEqualToString:@"127.0.0.1"] && ![host isEqualToString:@"localhost"]) {
        [[NSWorkspace sharedWorkspace] openURL:url];
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }

    decisionHandler(WKNavigationActionPolicyAllow);
}

// ---------- WKUIDelegate (Standalone popup windows, file open panel, JS alerts) ----------

- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration forNavigationAction:(WKNavigationAction *)navigationAction windowFeatures:(WKWindowFeatures *)windowFeatures {
    NSURL *url = navigationAction.request.URL;
    NSString *host = [url.host lowercaseString] ?: @"";
    if (url && ([url.scheme isEqualToString:@"http"] || [url.scheme isEqualToString:@"https"]) &&
        host.length > 0 && ![host isEqualToString:@"127.0.0.1"] && ![host isEqualToString:@"localhost"]) {
        [[NSWorkspace sharedWorkspace] openURL:url];
        return nil;
    }

    NSRect frame = NSMakeRect(0, 0, 1340, 880);
    NSUInteger style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;
    NSWindow *popupWin = [[NSWindow alloc] initWithContentRect:frame
                                                     styleMask:style
                                                       backing:NSBackingStoreBuffered
                                                         defer:NO];
    popupWin.title = @"smac Agent · 远程智能体工作台";
    if (@available(macOS 10.14, *)) {
        popupWin.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    }
    popupWin.backgroundColor = [NSColor colorWithCalibratedRed:0.043 green:0.059 blue:0.098 alpha:1.0];
    [popupWin center];

    WKWebView *popupWeb = [[WKWebView alloc] initWithFrame:((NSView *)popupWin.contentView).bounds configuration:configuration];
    popupWeb.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    popupWeb.UIDelegate = self;
    popupWeb.navigationDelegate = self;
    [popupWin.contentView addSubview:popupWeb];
    [self.popupWindows addObject:popupWin];
    [popupWin makeKeyAndOrderFront:nil];

    if (url && ![[url absoluteString] isEqualToString:@"about:blank"] && url.absoluteString.length > 0) {
        [popupWeb loadRequest:navigationAction.request];
    }
    return popupWeb;
}

- (void)webViewDidClose:(WKWebView *)webView {
    NSWindow *win = webView.window;
    if (win && win != self.mainWindow) {
        [win close];
        [self.popupWindows removeObject:win];
    }
}

- (void)webView:(WKWebView *)webView runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSArray<NSURL *> *URLs))completionHandler {
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.canChooseFiles = YES;
    panel.canChooseDirectories = NO;
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection;
    [panel beginSheetModalForWindow:(webView.window ?: self.mainWindow) completionHandler:^(NSModalResponse result) {
        if (result == NSModalResponseOK) {
            completionHandler(panel.URLs);
        } else {
            completionHandler(nil);
        }
    }];
}

- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completionHandler {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = self.appTitle;
    alert.informativeText = message ?: @"";
    [alert addButtonWithTitle:@"确定"];
    [alert runModal];
    completionHandler();
}

- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = self.appTitle;
    alert.informativeText = message ?: @"";
    [alert addButtonWithTitle:@"确定"];
    [alert addButtonWithTitle:@"取消"];
    NSModalResponse resp = [alert runModal];
    completionHandler(resp == NSAlertFirstButtonReturn);
}

@end

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        SmacAppDelegate *delegate = [[SmacAppDelegate alloc] init];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
