// Constructor Studio: repaint a ReactWidget now, not on the next frame.
//
// `Widget.update()` posts the request, so the render lands after the event
// that asked for it. A controlled `<input value={...}>` cannot wait that long:
// React puts the input back to its last committed value as soon as the change
// handler returns, and a render that commits later has already lost whatever
// was typed in between -- real key events arrive faster than frames. Sent
// instead of posted, the request renders inside the event, where React
// commits it before it restores the input.

import { MessageLoop } from "@theia/core/shared/@lumino/messaging";
import { Widget } from "@theia/core/shared/@lumino/widgets";

export function repaintNow(widget: Widget): void {
  if (widget.isDisposed) return;
  MessageLoop.sendMessage(widget, Widget.Msg.UpdateRequest);
}
