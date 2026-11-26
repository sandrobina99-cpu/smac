#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SMAC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

echo "==> 1/5 编译 Universal (arm64 + x86_64) 原生 macOS Cocoa + WKWebView 独立窗口二进制..."
if clang -arch arm64 -arch x86_64 -O2 -fobjc-arc -framework Cocoa -framework WebKit "$SCRIPT_DIR/smac-mac-app.m" -o "$SCRIPT_DIR/smac-mac-bin" 2>/dev/null; then
  echo "[OK] 已编译 Universal Binary (arm64 + x86_64): smac-mac-bin"
else
  clang -O2 -fobjc-arc -framework Cocoa -framework WebKit "$SCRIPT_DIR/smac-mac-app.m" -o "$SCRIPT_DIR/smac-mac-bin"
  echo "[OK] 已编译原生架构 Binary: smac-mac-bin"
fi
chmod +x "$SCRIPT_DIR/smac-mac-bin"

echo "==> 2/5 渲染 1024x1024 艺术级毛玻璃流光应用图标 (Host 星璇中枢 / Guest 翡翠量子节点)..."
cat > "$SCRIPT_DIR/make-icons.m" <<'EOF'
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>

static void drawRadialBlob(CGContextRef ctx, CGPoint center, CGFloat radius, NSColor *color) {
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGFloat r = 0, g = 0, b = 0, a = 0;
    NSColor *rgb = [color colorUsingColorSpace:[NSColorSpace deviceRGBColorSpace]];
    [rgb getRed:&r green:&g blue:&b alpha:&a];
    CGFloat comps[] = {
        r, g, b, a,
        r, g, b, a * 0.45,
        r, g, b, 0.0
    };
    CGFloat locs[] = { 0.0, 0.52, 1.0 };
    CGGradientRef grad = CGGradientCreateWithColorComponents(cs, comps, locs, 3);
    CGContextDrawRadialGradient(ctx, grad, center, 0, center, radius, kCGGradientDrawsAfterEndLocation);
    CGGradientRelease(grad);
    CGColorSpaceRelease(cs);
}

static NSBezierPath *squirclePath(NSRect rect, CGFloat radius) {
    return [NSBezierPath bezierPathWithRoundedRect:rect xRadius:radius yRadius:radius];
}

static void drawHostArtwork(CGContextRef ctx) {
    // 1. Aurora Nebulas
    drawRadialBlob(ctx, CGPointMake(280, 760), 540, [NSColor colorWithDeviceRed:0.04 green:0.78 blue:1.0 alpha:0.55]);
    drawRadialBlob(ctx, CGPointMake(760, 260), 560, [NSColor colorWithDeviceRed:0.68 green:0.18 blue:0.96 alpha:0.52]);
    drawRadialBlob(ctx, CGPointMake(512, 512), 420, [NSColor colorWithDeviceRed:0.25 green:0.38 blue:0.98 alpha:0.42]);

    // 2. Subtle Concentric Astral Grid Rings
    for (int i = 1; i <= 3; i++) {
        CGFloat rad = 135.0 * i;
        NSBezierPath *ring = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(512 - rad, 512 - rad, rad * 2, rad * 2)];
        [[NSColor colorWithDeviceWhite:1.0 alpha:(0.11 - i * 0.025)] setStroke];
        [ring setLineWidth:2.2];
        CGFloat dash[2] = { 10.0, 12.0 };
        if (i == 2) [ring setLineDash:dash count:2 phase:0];
        [ring stroke];
    }

    // 3. Interlocking Luminous Silk Wave Streams (Bi-directional Portal)
    // Upper Cyan-Blue Stream (Left-bottom -> Center-top -> Right-top)
    NSBezierPath *waveA = [NSBezierPath bezierPath];
    [waveA moveToPoint:NSMakePoint(215, 425)];
    [waveA curveToPoint:NSMakePoint(785, 635)
          controlPoint1:NSMakePoint(335, 775)
          controlPoint2:NSMakePoint(595, 760)];
    [waveA setLineCapStyle:NSLineCapStyleRound];

    // Outer neon glow for Wave A
    for (int g = 4; g >= 1; g--) {
        [[NSColor colorWithDeviceRed:0.05 green:0.85 blue:1.0 alpha:(0.09 * (5 - g))] setStroke];
        [waveA setLineWidth:(24 + g * 18)];
        [waveA stroke];
    }
    [[NSColor colorWithDeviceRed:0.55 green:0.96 blue:1.0 alpha:0.98] setStroke];
    [waveA setLineWidth:28];
    [waveA stroke];

    // Arrowhead / Wing on Wave A (Right-top)
    NSBezierPath *headA = [NSBezierPath bezierPath];
    [headA moveToPoint:NSMakePoint(725, 695)];
    [headA lineToPoint:NSMakePoint(812, 638)];
    [headA lineToPoint:NSMakePoint(742, 560)];
    [headA setLineCapStyle:NSLineCapStyleRound];
    [headA setLineJoinStyle:NSLineJoinStyleRound];
    [[NSColor colorWithDeviceRed:0.05 green:0.85 blue:1.0 alpha:0.35] setStroke];
    [headA setLineWidth:46];
    [headA stroke];
    [[NSColor colorWithDeviceRed:0.75 green:0.98 blue:1.0 alpha:1.0] setStroke];
    [headA setLineWidth:24];
    [headA stroke];

    // Lower Violet-Pink-Gold Stream (Right-top -> Center-bottom -> Left-bottom)
    NSBezierPath *waveB = [NSBezierPath bezierPath];
    [waveB moveToPoint:NSMakePoint(809, 599)];
    [waveB curveToPoint:NSMakePoint(239, 389)
          controlPoint1:NSMakePoint(689, 249)
          controlPoint2:NSMakePoint(429, 264)];
    [waveB setLineCapStyle:NSLineCapStyleRound];

    for (int g = 4; g >= 1; g--) {
        [[NSColor colorWithDeviceRed:0.88 green:0.25 blue:0.98 alpha:(0.09 * (5 - g))] setStroke];
        [waveB setLineWidth:(24 + g * 18)];
        [waveB stroke];
    }
    [[NSColor colorWithDeviceRed:0.96 green:0.62 blue:1.0 alpha:0.98] setStroke];
    [waveB setLineWidth:28];
    [waveB stroke];

    // Arrowhead / Wing on Wave B (Left-bottom)
    NSBezierPath *headB = [NSBezierPath bezierPath];
    [headB moveToPoint:NSMakePoint(299, 329)];
    [headB lineToPoint:NSMakePoint(212, 386)];
    [headB lineToPoint:NSMakePoint(282, 464)];
    [headB setLineCapStyle:NSLineCapStyleRound];
    [headB setLineJoinStyle:NSLineJoinStyleRound];
    [[NSColor colorWithDeviceRed:0.88 green:0.25 blue:0.98 alpha:0.35] setStroke];
    [headB setLineWidth:46];
    [headB stroke];
    [[NSColor colorWithDeviceRed:0.98 green:0.78 blue:1.0 alpha:1.0] setStroke];
    [headB setLineWidth:24];
    [headB stroke];

    // 4. Central Frosted Glass Core Nexus Sphere
    drawRadialBlob(ctx, CGPointMake(512, 512), 195, [NSColor colorWithDeviceRed:0.25 green:0.82 blue:1.0 alpha:0.65]);
    NSRect orbRect = NSMakeRect(512 - 112, 512 - 112, 224, 224);
    NSBezierPath *orbPath = [NSBezierPath bezierPathWithOvalInRect:orbRect];
    NSGradient *orbGrad = [[NSGradient alloc] initWithColorsAndLocations:
        [NSColor colorWithDeviceRed:0.45 green:0.92 blue:1.0 alpha:0.92], 0.0,
        [NSColor colorWithDeviceRed:0.28 green:0.42 blue:0.96 alpha:0.88], 0.55,
        [NSColor colorWithDeviceRed:0.52 green:0.18 blue:0.88 alpha:0.92], 1.0, nil];
    [orbGrad drawInBezierPath:orbPath angle:135];

    [[NSColor colorWithDeviceWhite:1.0 alpha:0.65] setStroke];
    [orbPath setLineWidth:5.0];
    [orbPath stroke];

    // Inner specular highlight on central orb
    NSBezierPath *orbSpec = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(512 - 72, 512 + 18, 110, 62)];
    NSGradient *specGrad = [[NSGradient alloc] initWithStartingColor:[NSColor colorWithDeviceWhite:1.0 alpha:0.68]
                                                         endingColor:[NSColor colorWithDeviceWhite:1.0 alpha:0.0]];
    [specGrad drawInBezierPath:orbSpec angle:90];

    // 5. Orbiting Star Pearls
    CGPoint pearls[] = { {330, 715}, {715, 315}, {255, 605}, {765, 420} };
    for (int i = 0; i < 4; i++) {
        CGFloat pr = (i < 2) ? 16.0 : 10.0;
        drawRadialBlob(ctx, pearls[i], pr * 3.2, [NSColor colorWithDeviceRed:0.4 green:0.95 blue:1.0 alpha:0.8]);
        NSBezierPath *p = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(pearls[i].x - pr, pearls[i].y - pr, pr * 2, pr * 2)];
        [[NSColor colorWithDeviceWhite:1.0 alpha:0.95] setFill];
        [p fill];
    }
}

static void drawGuestArtwork(CGContextRef ctx) {
    // 1. Bioluminescent Emerald & Arctic Cyan Aurora Nebulas
    drawRadialBlob(ctx, CGPointMake(290, 740), 540, [NSColor colorWithDeviceRed:0.06 green:0.88 blue:0.62 alpha:0.52]);
    drawRadialBlob(ctx, CGPointMake(740, 280), 540, [NSColor colorWithDeviceRed:0.04 green:0.72 blue:0.92 alpha:0.50]);
    drawRadialBlob(ctx, CGPointMake(512, 512), 390, [NSColor colorWithDeviceRed:0.35 green:0.95 blue:0.55 alpha:0.34]);

    // 2. Two Tilted 3D Elliptical Quantum Orbits (+34 deg and -34 deg)
    CGFloat angles[2] = { 34.0, -34.0 };
    for (int i = 0; i < 2; i++) {
        [NSGraphicsContext saveGraphicsState];
        NSAffineTransform *tf = [NSAffineTransform transform];
        [tf translateXBy:512 yBy:512];
        [tf rotateByDegrees:angles[i]];
        [tf concat];

        NSBezierPath *orbit = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(-330, -138, 660, 276)];
        for (int g = 3; g >= 1; g--) {
            NSColor *gc = (i == 0)
                ? [NSColor colorWithDeviceRed:0.10 green:0.95 blue:0.70 alpha:(0.08 * (4 - g))]
                : [NSColor colorWithDeviceRed:0.15 green:0.82 blue:1.00 alpha:(0.08 * (4 - g))];
            [gc setStroke];
            [orbit setLineWidth:(10 + g * 12)];
            [orbit stroke];
        }
        NSColor *coreCol = (i == 0)
            ? [NSColor colorWithDeviceRed:0.52 green:1.00 blue:0.84 alpha:0.95]
            : [NSColor colorWithDeviceRed:0.55 green:0.94 blue:1.00 alpha:0.92];
        [coreCol setStroke];
        [orbit setLineWidth:12.0];
        [orbit stroke];

        // Glowing satellite node on orbit
        CGFloat sx = (i == 0) ? 285.0 : -285.0;
        CGFloat sy = (i == 0) ? 68.0 : -68.0;
        drawRadialBlob(ctx, CGPointMake(sx, sy), 58, [NSColor colorWithDeviceRed:0.3 green:1.0 blue:0.82 alpha:0.9]);
        NSBezierPath *sat = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(sx - 20, sy - 20, 40, 40)];
        [[NSColor whiteColor] setFill];
        [sat fill];

        [NSGraphicsContext restoreGraphicsState];
    }

    // 3. Central Translucent Glass Hexagonal / Octagonal Crystal Prism
    drawRadialBlob(ctx, CGPointMake(512, 512), 230, [NSColor colorWithDeviceRed:0.12 green:0.96 blue:0.72 alpha:0.62]);

    NSBezierPath *hex = [NSBezierPath bezierPath];
    CGFloat R = 165.0;
    for (int k = 0; k < 6; k++) {
        CGFloat rad = (90.0 + k * 60.0) * M_PI / 180.0;
        CGPoint pt = CGPointMake(512 + R * cos(rad), 512 + R * sin(rad));
        if (k == 0) [hex moveToPoint:pt];
        else [hex lineToPoint:pt];
    }
    [hex closePath];
    [hex setLineJoinStyle:NSLineJoinStyleRound];

    NSGradient *hexGrad = [[NSGradient alloc] initWithColorsAndLocations:
        [NSColor colorWithDeviceRed:0.35 green:0.98 blue:0.78 alpha:0.92], 0.0,
        [NSColor colorWithDeviceRed:0.06 green:0.68 blue:0.68 alpha:0.88], 0.55,
        [NSColor colorWithDeviceRed:0.05 green:0.38 blue:0.58 alpha:0.94], 1.0, nil];
    [hexGrad drawInBezierPath:hex angle:125];

    // Inner facet lines for 3D crystal look
    NSBezierPath *facets = [NSBezierPath bezierPath];
    for (int k = 0; k < 6; k += 2) {
        CGFloat rad = (90.0 + k * 60.0) * M_PI / 180.0;
        [facets moveToPoint:NSMakePoint(512, 512)];
        [facets lineToPoint:NSMakePoint(512 + R * cos(rad), 512 + R * sin(rad))];
    }
    [[NSColor colorWithDeviceWhite:1.0 alpha:0.28] setStroke];
    [facets setLineWidth:3.5];
    [facets stroke];

    [[NSColor colorWithDeviceWhite:1.0 alpha:0.78] setStroke];
    [hex setLineWidth:7.0];
    [hex stroke];

    // Inner glowing energy pulse core
    NSBezierPath *coreOrb = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(512 - 54, 512 - 54, 108, 108)];
    NSGradient *coreGrad = [[NSGradient alloc] initWithStartingColor:[NSColor colorWithDeviceWhite:1.0 alpha:0.98]
                                                         endingColor:[NSColor colorWithDeviceRed:0.25 green:0.98 blue:0.78 alpha:0.85]];
    [coreGrad drawInBezierPath:coreOrb relativeCenterPosition:NSMakePoint(-0.2, 0.2)];
}

static void renderIcon(NSString *outPath, BOOL isGuest) {
    int size = 1024;
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc]
        initWithBitmapDataPlanes:NULL
                      pixelsWide:size
                      pixelsHigh:size
                   bitsPerSample:8
                 samplesPerPixel:4
                        hasAlpha:YES
                        isPlanar:NO
                  colorSpaceName:NSDeviceRGBColorSpace
                     bytesPerRow:0
                    bitsPerPixel:0];

    NSGraphicsContext *nsCtx = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:nsCtx];
    CGContextRef ctx = [nsCtx CGContext];

    NSRect cardRect = NSMakeRect(76, 76, 872, 872);
    CGFloat cornerRadius = 200.0;
    NSBezierPath *squircle = squirclePath(cardRect, cornerRadius);

    // Outer ambient drop shadow
    [NSGraphicsContext saveGraphicsState];
    NSShadow *shadow = [[NSShadow alloc] init];
    shadow.shadowOffset = NSMakeSize(0, -20);
    shadow.shadowBlurRadius = 44.0;
    shadow.shadowColor = [NSColor colorWithDeviceWhite:0.0 alpha:0.60];
    [shadow set];
    [[NSColor colorWithDeviceRed:0.04 green:0.06 blue:0.12 alpha:1.0] setFill];
    [squircle fill];
    [NSGraphicsContext restoreGraphicsState];

    // Clip to squircle
    [NSGraphicsContext saveGraphicsState];
    [squircle addClip];

    // Deep obsidian base gradient
    NSColor *bgStart = isGuest
        ? [NSColor colorWithDeviceRed:0.02 green:0.08 blue:0.11 alpha:1.0]
        : [NSColor colorWithDeviceRed:0.03 green:0.05 blue:0.13 alpha:1.0];
    NSColor *bgEnd = isGuest
        ? [NSColor colorWithDeviceRed:0.05 green:0.17 blue:0.21 alpha:1.0]
        : [NSColor colorWithDeviceRed:0.08 green:0.07 blue:0.23 alpha:1.0];
    NSGradient *bgGrad = [[NSGradient alloc] initWithStartingColor:bgStart endingColor:bgEnd];
    [bgGrad drawInRect:cardRect angle:135];

    if (isGuest) {
        drawGuestArtwork(ctx);
    } else {
        drawHostArtwork(ctx);
    }

    // Top glass sheen reflection across squircle
    NSBezierPath *sheen = [NSBezierPath bezierPath];
    [sheen moveToPoint:NSMakePoint(76, 948)];
    [sheen lineToPoint:NSMakePoint(948, 948)];
    [sheen lineToPoint:NSMakePoint(948, 630)];
    [sheen curveToPoint:NSMakePoint(76, 540)
          controlPoint1:NSMakePoint(660, 720)
          controlPoint2:NSMakePoint(350, 680)];
    [sheen closePath];
    NSGradient *sheenGrad = [[NSGradient alloc] initWithStartingColor:[NSColor colorWithDeviceWhite:1.0 alpha:0.15]
                                                          endingColor:[NSColor colorWithDeviceWhite:1.0 alpha:0.0]];
    [sheenGrad drawInBezierPath:sheen angle:-90];

    [NSGraphicsContext restoreGraphicsState];

    // Specular outer glass rim border
    NSBezierPath *innerRim = squirclePath(NSInsetRect(cardRect, 3.0, 3.0), cornerRadius - 3.0);
    [[NSColor colorWithDeviceWhite:1.0 alpha:0.24] setStroke];
    [innerRim setLineWidth:6.0];
    [innerRim stroke];

    [NSGraphicsContext restoreGraphicsState];
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    [png writeToFile:outPath atomically:YES];
}

static void renderDmgBackground(NSString *outPath) {
    int w = 660, h = 400;
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc]
        initWithBitmapDataPlanes:NULL
                      pixelsWide:w
                      pixelsHigh:h
                   bitsPerSample:8
                 samplesPerPixel:4
                        hasAlpha:YES
                        isPlanar:NO
                  colorSpaceName:NSDeviceRGBColorSpace
                     bytesPerRow:0
                    bitsPerPixel:0];
    NSGraphicsContext *nsCtx = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:nsCtx];
    CGContextRef ctx = [nsCtx CGContext];

    NSGradient *bg = [[NSGradient alloc] initWithStartingColor:[NSColor colorWithDeviceRed:0.05 green:0.07 blue:0.12 alpha:1.0]
                                                   endingColor:[NSColor colorWithDeviceRed:0.08 green:0.11 blue:0.19 alpha:1.0]];
    [bg drawInRect:NSMakeRect(0, 0, w, h) angle:135];

    drawRadialBlob(ctx, CGPointMake(180, 210), 210, [NSColor colorWithDeviceRed:0.12 green:0.65 blue:0.98 alpha:0.18]);
    drawRadialBlob(ctx, CGPointMake(480, 210), 210, [NSColor colorWithDeviceRed:0.45 green:0.25 blue:0.95 alpha:0.16]);

    // Glowing drag arrow from x=275 to x=385 at y=215
    NSBezierPath *arrow = [NSBezierPath bezierPath];
    [arrow moveToPoint:NSMakePoint(275, 215)];
    [arrow lineToPoint:NSMakePoint(378, 215)];
    [arrow moveToPoint:NSMakePoint(354, 237)];
    [arrow lineToPoint:NSMakePoint(382, 215)];
    [arrow lineToPoint:NSMakePoint(354, 193)];
    [arrow setLineCapStyle:NSLineCapStyleRound];
    [arrow setLineJoinStyle:NSLineJoinStyleRound];

    [[NSColor colorWithDeviceRed:0.22 green:0.75 blue:1.0 alpha:0.28] setStroke];
    [arrow setLineWidth:12.0];
    [arrow stroke];

    [[NSColor colorWithDeviceRed:0.55 green:0.88 blue:1.0 alpha:0.92] setStroke];
    [arrow setLineWidth:4.5];
    [arrow stroke];

    NSMutableParagraphStyle *ps = [[NSMutableParagraphStyle alloc] init];
    ps.alignment = NSTextAlignmentCenter;
    NSDictionary *attr = @{
        NSFontAttributeName: [NSFont systemFontOfSize:14 weight:NSFontWeightMedium],
        NSForegroundColorAttributeName: [NSColor colorWithDeviceWhite:0.78 alpha:0.88],
        NSParagraphStyleAttributeName: ps
    };
    [@"将左侧应用图标拖动到右侧 Applications 文件夹即可完成安装" drawInRect:NSMakeRect(40, 36, 580, 32) withAttributes:attr];

    [NSGraphicsContext restoreGraphicsState];
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    [png writeToFile:outPath atomically:YES];
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSString *dir = [NSString stringWithUTF8String:argv[1]];
        renderIcon([dir stringByAppendingPathComponent:@"icon-host-1024.png"], NO);
        renderIcon([dir stringByAppendingPathComponent:@"icon-guest-1024.png"], YES);
        renderDmgBackground([dir stringByAppendingPathComponent:@"dmg-bg.png"]);
    }
    return 0;
}
EOF

clang -O2 -fobjc-arc -framework Cocoa -framework QuartzCore "$SCRIPT_DIR/make-icons.m" -o "$SCRIPT_DIR/make-icons-bin"
"$SCRIPT_DIR/make-icons-bin" "$SCRIPT_DIR"
rm -f "$SCRIPT_DIR/make-icons.m" "$SCRIPT_DIR/make-icons-bin"

build_icns() {
  local src_png="$1"
  local out_icns="$2"
  local iconset="$SCRIPT_DIR/tmp.iconset"
  rm -rf "$iconset"
  mkdir -p "$iconset"
  for sz in 16 32 128 256 512; do
    sips -z $sz $sz "$src_png" --out "$iconset/icon_${sz}x${sz}.png" >/dev/null 2>&1
    local sz2=$((sz * 2))
    sips -z $sz2 $sz2 "$src_png" --out "$iconset/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1
  done
  iconutil -c icns "$iconset" -o "$out_icns"
  rm -rf "$iconset"
}

build_icns "$SCRIPT_DIR/icon-host-1024.png" "$SCRIPT_DIR/AppIcon-host.icns"
build_icns "$SCRIPT_DIR/icon-guest-1024.png" "$SCRIPT_DIR/AppIcon-guest.icns"
echo "[OK] 已生成艺术级 AppIcon-host.icns、AppIcon-guest.icns 与 1024px PNG 母版"

assemble_app() {
  local mode="$1"
  local app_name="$2"
  local bundle_id="$3"
  local exec_name="$4"
  local icns_file="$5"
  local target_dir="$6"

  local app_path="$target_dir/$app_name.app"
  rm -rf "$app_path"
  mkdir -p "$app_path/Contents/MacOS" "$app_path/Contents/Resources/app"

  cp "$SCRIPT_DIR/smac-mac-bin" "$app_path/Contents/MacOS/$exec_name"
  chmod +x "$app_path/Contents/MacOS/$exec_name"
  cp "$icns_file" "$app_path/Contents/Resources/AppIcon.icns"

  cat > "$app_path/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>${app_name}</string>
  <key>CFBundleName</key>
  <string>${app_name}</string>
  <key>CFBundleExecutable</key>
  <string>${exec_name}</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>${bundle_id}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>2.1.0</string>
  <key>CFBundleVersion</key>
  <string>210</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
  </dict>
  <key>SmacAppMode</key>
  <string>${mode}</string>
</dict>
</plist>
PLIST

  if [ "$mode" = "host" ]; then
    cp -R "$SMAC_ROOT/web" "$app_path/Contents/Resources/app/web"
    cp -R "$SMAC_ROOT/agent" "$app_path/Contents/Resources/app/agent"
    cp -R "$SMAC_ROOT/guest" "$app_path/Contents/Resources/app/guest"
    [ -f "$SMAC_ROOT/smac.sh" ] && cp "$SMAC_ROOT/smac.sh" "$app_path/Contents/Resources/app/smac.sh" && chmod +x "$app_path/Contents/Resources/app/smac.sh"
  else
    mkdir -p "$app_path/Contents/Resources/app/guest"
    cp "$SMAC_ROOT/guest/guest-server.js" \
       "$SMAC_ROOT/guest/guest.html" \
       "$SMAC_ROOT/guest/guest.css" \
       "$SMAC_ROOT/guest/guest.js" \
       "$SMAC_ROOT/guest/guest-env.js" \
       "$app_path/Contents/Resources/app/guest/"
  fi

  # 彻底清理任何本地缓存、二进制插件或私人配置文件，确保打包进 DMG 的 .app 100% 纯净
  rm -rf "$app_path/Contents/Resources/app/web/node_modules/cpu-features" \
         "$app_path/Contents/Resources/app/web/node_modules/ssh2/lib/protocol/crypto/build" 2>/dev/null || true
  find "$app_path/Contents/Resources/app" \( \
    -name "*.node" -o -name "*.dll" -o -name "*.dylib" -o -name "*.so" -o \
    -name "*.exe" -o -name "*.ico" -o -name "*.log" -o -name "*.pid" -o \
    -name "host-pairing.json" -o -name "guest-pairing.json" -o -name "devices.json" -o \
    -name "config.json" -o -name "agent-credentials.json" -o -name "bootstrap-peer.json" -o \
    -name "host-profile.json" -o -name "host-profile.seed.json" -o -name "pairing-code.txt" \
  \) -delete 2>/dev/null || true

  xattr -cr "$app_path" 2>/dev/null || true
  codesign --force --deep --sign - "$app_path" >/dev/null 2>&1 || true
}

echo "==> 3/5 安装新版图标的 smac 主机控制台.app 与 smac 客机控制台.app 到 /Applications ..."
assemble_app "host"  "smac 主机控制台" "com.smac.host"  "smac-host"  "$SCRIPT_DIR/AppIcon-host.icns"  "/Applications"
assemble_app "guest" "smac 客机控制台" "com.smac.guest" "smac-guest" "$SCRIPT_DIR/AppIcon-guest.icns" "/Applications"
touch "/Applications/smac 主机控制台.app" "/Applications/smac 客机控制台.app"

echo "==> 4/5 构建可拖拽安装的 macOS DMG 镜像 (smac-host-macos.dmg / smac-guest-macos.dmg)..."
mkdir -p "$SMAC_ROOT/dist"

build_dmg() {
  local app_name="$1"
  local icns_file="$2"
  local out_dmg="$3"
  local stage_dir="$SCRIPT_DIR/dmg-stage"
  local rw_dmg="$SCRIPT_DIR/tmp-rw.dmg"

  rm -rf "$stage_dir" "$rw_dmg" "$out_dmg"
  mkdir -p "$stage_dir/.background"
  cp -R "/Applications/${app_name}.app" "$stage_dir/${app_name}.app"
  ln -s /Applications "$stage_dir/Applications"
  cp "$SCRIPT_DIR/dmg-bg.png" "$stage_dir/.background/bg.png"
  cp "$icns_file" "$stage_dir/.VolumeIcon.icns"
  if command -v SetFile >/dev/null 2>&1; then
    SetFile -a C "$stage_dir" 2>/dev/null || true
  fi

  hdiutil create -volname "$app_name" -srcfolder "$stage_dir" -ov -format UDZO -imagekey zlib-level=9 "$out_dmg" >/dev/null
  rm -rf "$stage_dir" "$rw_dmg"
  echo "[OK] 已生成拖拽安装 DMG: $out_dmg ($(du -h "$out_dmg" | awk '{print $1}'))"
}

build_dmg "smac 主机控制台" "$SCRIPT_DIR/AppIcon-host.icns"  "$SMAC_ROOT/dist/smac-host-macos.dmg"
build_dmg "smac 客机控制台" "$SCRIPT_DIR/AppIcon-guest.icns" "$SMAC_ROOT/dist/smac-guest-macos.dmg"

echo "==> 5/5 刷新 macOS LaunchServices、Dock 图标缓存与 Spotlight 索引..."
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREG" ]; then
  "$LSREG" -f "/Applications/smac 主机控制台.app" "/Applications/smac 客机控制台.app" || true
fi
mdimport "/Applications/smac 主机控制台.app" "/Applications/smac 客机控制台.app" 2>/dev/null || true
ln -sf "/Applications/smac 主机控制台.app" "$HOME/Desktop/smac 主机控制台.app" 2>/dev/null || true
ln -sf "/Applications/smac 客机控制台.app" "$HOME/Desktop/smac 客机控制台.app" 2>/dev/null || true

echo "[OK] macOS 艺术图标、独立窗口 App 与拖拽安装 DMG 全部构建完成！"
