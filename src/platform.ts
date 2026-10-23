/** wallp runs on Windows and GNOME; WebKitGTK reports Linux in its user agent. */
export const isLinux = typeof navigator !== "undefined" && /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
