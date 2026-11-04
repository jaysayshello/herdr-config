#!/usr/bin/env osascript -l JavaScript
// An alert card drawn like Herdr's sidebar (theme colors, the space's wizard sprite, rounded
// border), for peon-ping's notify.sh. Forked from peon-ping's mac-overlay-glass.js (MIT,
// github.com/PeonPing/peon-ping). notify.sh accepts only its own theme names, so
// ~/.config/herdr-app/peon/ is a PEON_DIR where scripts/mac-overlay-glass.js links to this file;
// scripts/herdr-alert.sh sends Herdr's toasts through notify.sh with that PEON_DIR.
// Usage (notify.sh): <message> <color> <icon_path> <slot> <dismiss_seconds> [bundle_id] [ide_pid]
//   [session_tty] [subtitle] [position] [notify_type] [all_screens] [screen_index] [close_button]
// position "herdr": the strip between the menu bar and the Herdr window, at its left edge.
// Env: PEON_CLICK_COMMAND (run on click), HERDR_ALERT_THEME (JSON of #rrggbb colors), HERDR_ALERT_TITLE.

ObjC.import('Cocoa');
ObjC.import('QuartzCore');

// Herdr's "ghostty" theme, for alerts that don't pass the live theme (peon's own hooks).
var DEFAULT_THEME = {
  background: '#1e1e2e', foreground: '#ffffff', muted: '#a6a8b4', dim: '#6c6f80',
  border: '#3a3c4e', accent: '#81a2be', done: '#b5bd68', blocked: '#f0c674', error: '#cc6666',
};

function run(argv) {
  var message  = argv[0] || 'peon-ping';
  var color    = argv[1] || 'blue';
  var iconPath = argv[2] || '';
  var slot     = parseInt(argv[3], 10) || 0;
  var dismiss  = argv[4] !== undefined ? parseFloat(argv[4]) : 5;
  if (isNaN(dismiss)) dismiss = 5;
  var bundleId   = argv[5] || '';
  var subtitle   = argv[8] || '';
  var position   = argv[9] || 'top-center';
  var notifType  = argv[10] || '';
  var screenIdx  = (argv[12] !== undefined && argv[12] !== '') ? parseInt(argv[12], 10) : -1;
  var showClose  = (argv[13] || 'true') === 'true';

  var env = $.NSProcessInfo.processInfo.environment;
  function envStr(k) { var v = env.objectForKey($(k)); return v && !v.isNil() ? ObjC.unwrap(v) : ''; }
  var clickCommand = envStr('PEON_CLICK_COMMAND');
  var title = envStr('HERDR_ALERT_TITLE');
  var theme = DEFAULT_THEME;
  function rgb(hex) {
    var h = String(hex || '#888888').replace('#', '');
    return [0, 2, 4].map(function (i) { var v = parseInt(h.slice(i, i + 2), 16) / 255; return isNaN(v) ? 0.5 : v; });
  }
  function ns(hex, a) { var c = rgb(hex); return $.NSColor.colorWithSRGBRedGreenBlueAlpha(c[0], c[1], c[2], a); }
  // A retained CGColor: NSColor's .CGColor is autoreleased in JXA, and a layer given one later
  // can hang the script.
  function cg(hex, a) { var c = rgb(hex); return $.CGColorCreateGenericRGB(c[0], c[1], c[2], a); }

  // What happened, and its color: done green, waiting yellow, error red, else the accent.
  var kind, tone;
  switch (notifType) {
    case 'complete':   kind = 'Done';      tone = theme.done;    break;
    case 'permission': kind = 'Needs you'; tone = theme.blocked; break;
    case 'question':   kind = 'Needs you'; tone = theme.blocked; break;
    case 'limit':      kind = 'Limit';     tone = theme.error;   break;
    case 'error':      kind = 'Error';     tone = theme.error;   break;
    case 'idle':       kind = 'Idle';      tone = theme.dim;     break;
    case 'info':       kind = 'Herdr';     tone = theme.accent;  break;
    default:
      kind = color === 'red' ? 'Needs you' : color === 'yellow' ? 'Idle' : 'Done';
      tone = color === 'red' ? theme.blocked : color === 'yellow' ? theme.dim : theme.done;
  }
  // notify.sh sends the title as the message and the body as the subtitle: show each once.
  if (!title || message === title) { title = title || message; message = ''; }

  var winW = 520, winH = 140, pad = 8;
  var cardW = winW - pad * 2, cardH = winH - pad * 2, radius = 10;

  $.NSApplication.sharedApplication;
  $.NSApp.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var dismissName = 'com.herdr.alert.dismiss.' + slot;

  var screens = $.NSScreen.screens, target = screens.objectAtIndex(0);
  if (screenIdx >= 0 && screenIdx < screens.count) target = screens.objectAtIndex(screenIdx);
  else {
    var m = $.NSEvent.mouseLocation;
    for (var s = 0; s < screens.count; s++) {
      var f = screens.objectAtIndex(s).frame;
      if (m.x >= f.origin.x && m.x <= f.origin.x + f.size.width && m.y >= f.origin.y && m.y <= f.origin.y + f.size.height) { target = screens.objectAtIndex(s); break; }
    }
  }
  var vf = target.visibleFrame, sf = target.frame, margin = 10, off = margin + slot * (winH + 4), x, y;
  var left = vf.origin.x + margin, right = vf.origin.x + vf.size.width - winW - margin, center = vf.origin.x + (vf.size.width - winW) / 2;
  var top = vf.origin.y + vf.size.height - winH - off, bottom = vf.origin.y + off;
  switch (position) {
    case 'herdr': x = sf.origin.x + 150; y = sf.origin.y + sf.size.height - 76 - winH - slot * (winH + 4); break;
    case 'top-right': x = right; y = top; break;
    case 'top-left': x = left; y = top; break;
    case 'bottom-right': x = right; y = bottom; break;
    case 'bottom-left': x = left; y = bottom; break;
    case 'bottom-center': x = center; y = bottom; break;
    default: x = center; y = top;
  }

  var win = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(x, y, winW, winH), $.NSWindowStyleMaskBorderless | (1 << 7), $.NSBackingStoreBuffered, false);
  win.setBackgroundColor($.NSColor.clearColor);
  win.setOpaque(false); win.setHasShadow(false); win.setAlphaValue(0.0);
  win.setLevel($.NSStatusWindowLevel);
  win.setCollectionBehavior($.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorStationary);
  win.contentView.wantsLayer = true;

  // The card: the sidebar's background, a 1px border, the theme's rounded corners, a soft shadow.
  var card = $.NSView.alloc.initWithFrame($.NSMakeRect(pad, pad, cardW, cardH));
  card.setWantsLayer(true);
  var path = $.CGPathCreateWithRoundedRect($.CGRectMake(0, 0, cardW, cardH), radius, radius, null);
  var bg = $.CAShapeLayer.layer; bg.setPath(path); bg.setFillColor(cg(theme.background, 0.97)); card.layer.addSublayer(bg);
  var border = $.CAShapeLayer.layer; border.setPath(path); border.setFillColor(null);
  border.setStrokeColor(cg(tone, 0.55)); border.setLineWidth(1.0); card.layer.addSublayer(border);
  card.layer.shadowColor = cg('#000000', 1); card.layer.shadowRadius = 8;
  card.layer.shadowOpacity = 0.35; card.layer.shadowOffset = $.CGSizeMake(0, -2);
  // Dismiss progress, along the bottom edge in the tone color.
  var line = $.CGPathCreateMutable();
  $.CGPathMoveToPoint(line, null, radius, 1); $.CGPathAddLineToPoint(line, null, cardW - radius, 1);
  var progress = $.CAShapeLayer.layer; progress.setPath(line); progress.setFillColor(null);
  progress.setStrokeColor(cg(tone, 0.8)); progress.setLineWidth(1.5); progress.setStrokeEnd(0);
  card.layer.addSublayer(progress);
  win.contentView.addSubview(card);

  // The space's wizard, pixels kept sharp; without one, a dot in the tone color.
  var iconSize = 72, iconX = pad + 18, iconY = pad + (cardH - iconSize) / 2;
  var img = iconPath ? $.NSImage.alloc.initWithContentsOfFile($(iconPath)) : null;
  if (img && !img.isNil()) {
    var iv = $.NSImageView.alloc.initWithFrame($.NSMakeRect(iconX, iconY, iconSize, iconSize));
    iv.setImage(img); iv.setImageScaling($.NSImageScaleProportionallyUpOrDown);
    iv.setWantsLayer(true); iv.layer.magnificationFilter = $.kCAFilterNearest;
    win.contentView.addSubview(iv);
  } else {
    // On the card's layer (its coordinates): the content view's own layer is under the card.
    var dot = $.CAShapeLayer.layer;
    dot.setPath($.CGPathCreateWithEllipseInRect($.CGRectMake(iconX - pad + 14, iconY - pad + 14, 12, 12), null));
    dot.setFillColor(cg(tone, 1)); card.layer.addSublayer(dot);
  }

  function label(text, lx, ly, w, size, weight, hex, alpha) {
    var l = $.NSTextField.alloc.initWithFrame($.NSMakeRect(lx, ly, w, size + 6));
    l.setStringValue($(text)); l.setBezeled(false); l.setDrawsBackground(false);
    l.setEditable(false); l.setSelectable(false);
    l.setTextColor(ns(hex, alpha)); l.setFont($.NSFont.systemFontOfSizeWeight(size, weight));
    l.cell.setLineBreakMode($.NSLineBreakByTruncatingTail);
    win.contentView.addSubview(l);
  }
  var textX = iconX + iconSize + 18, textW = pad + cardW - textX - 40;
  var now = new Date(), ts = ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2);
  label(kind + '  ·  ' + ts, textX, pad + cardH - 36, textW, 13, $.NSFontWeightMedium, tone, 1);
  label(title, textX, pad + cardH - 64, textW, 18, $.NSFontWeightSemibold, theme.foreground, 1);
  var detail = [message, subtitle].filter(function (v) { return v; }).join('  ·  ');
  if (detail) label(detail, textX, pad + cardH - 90, textW, 15, $.NSFontWeightRegular, theme.muted, 1);

  function runClick() {
    if (clickCommand) {
      try {
        var task = $.NSTask.alloc.init;
        task.setLaunchPath($('/bin/bash')); task.setArguments($(['-lc', clickCommand]));
        task.launch; task.waitUntilExit;
      } catch (e) {}
    } else if (bundleId) {
      var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier($(bundleId));
      if (apps.count > 0) apps.objectAtIndex(0).activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
    }
  }
  function closeAll() {
    $.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObject($(dismissName), $.NSString.string);
    win.orderOut(null);
    $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.05, $.NSApp, 'terminate:', null, false);
  }
  ObjC.registerSubclass({
    name: 'HerdrAlertHandler', superclass: 'NSObject',
    methods: {
      'open': { types: ['void', []], implementation: function () { runClick(); closeAll(); } },
      'close': { types: ['void', []], implementation: function () { closeAll(); } },
      'dismissed:': { types: ['void', ['id']], implementation: function () { $.NSApp.terminate(null); } },
    },
  });
  var handler = $.HerdrAlertHandler.alloc.init;
  var hit = $.NSButton.alloc.initWithFrame($.NSMakeRect(0, 0, winW, winH));
  hit.setTitle($('')); hit.setBordered(false); hit.setTransparent(true);
  hit.setTarget(handler); hit.setAction('open'); win.contentView.addSubview(hit);
  if (showClose) {
    var cx = pad + cardW - 30, cy = pad + cardH - 30;
    label('\u00D7', cx, cy, 22, 16, $.NSFontWeightRegular, theme.dim, 1);
    var xb = $.NSButton.alloc.initWithFrame($.NSMakeRect(cx - 4, cy - 4, 28, 28));
    xb.setTitle($('')); xb.setBordered(false); xb.setTransparent(true);
    xb.setTarget(handler); xb.setAction('close'); win.contentView.addSubview(xb);
  }
  $.NSDistributedNotificationCenter.defaultCenter.addObserverSelectorNameObject(handler, 'dismissed:', $(dismissName), $.NSString.string);

  win.orderFrontRegardless;
  win.animator.setAlphaValue(1.0);
  if (dismiss > 0) {
    var steps = 120, n = { v: 0 };
    ObjC.registerSubclass({
      name: 'HerdrAlertTimer', superclass: 'NSObject',
      methods: { 'tick:': { types: ['void', ['id']], implementation: function (timer) {
        n.v++;
        var p = Math.min(n.v / steps, 1);
        progress.setStrokeEnd(p);
        if (p > 0.85) win.setAlphaValue(1 - (p - 0.85) / 0.15);
        if (n.v >= steps) { timer.invalidate; win.orderOut(null); }
      } } },
    });
    $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(dismiss / steps, $.HerdrAlertTimer.alloc.init, 'tick:', null, true);
    $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(dismiss + 0.3, $.NSApp, 'terminate:', null, false);
  }
  $.NSApp.run;
}
