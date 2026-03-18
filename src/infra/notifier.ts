/**
 * OS 通知（macOS osascript → execFile，其他平台静默）。
 */

import { execFile } from "node:child_process";

export function notify(title: string, message: string): void {
  const safe = message.replace(/"/g, '\\"').slice(0, 120);
  const safeTitle = title.replace(/"/g, '\\"');
  if (process.platform === "darwin") {
    execFile("osascript", ["-e", `display notification "${safe}" with title "${safeTitle}"`], (err) => {
      if (err) console.warn(`Notification failed: ${err.message}`);
    });
  }
}
