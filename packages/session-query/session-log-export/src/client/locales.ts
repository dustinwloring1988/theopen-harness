/** Locale namespace owned by Session export browser feedback. */
export const NS = 'session-log-download'

/** Simplified-Chinese Session export strings. */
export const zh = {
  'dialog.preparingTitle': '正在导出 Session',
  'dialog.preparingDescription': '正在准备包含当前 Session、子 Session 和附件的 ZIP 文件。',
  'dialog.preparingMarkdownDescription': '正在整理当前会话窗口的 Markdown 转写文稿。',
  'dialog.successTitle': 'Session 导出已开始下载',
  'dialog.successDescription': '浏览器正在下载 Session ZIP 文件。',
  'dialog.successMarkdownDescription': '浏览器正在下载会话 Markdown 转写文稿。',
  'dialog.errorTitle': 'Session 导出失败',
  'dialog.close': '关闭',
  'dialog.commandFailed': '无法启动 Session 导出。',
} as const

/** English Session export strings. */
export const en: Record<keyof typeof zh, string> = {
  'dialog.preparingTitle': 'Exporting Session',
  'dialog.preparingDescription': 'Preparing a ZIP containing this Session, its sub-Sessions, and attachments.',
  'dialog.preparingMarkdownDescription': 'Assembling the Markdown transcript for this session window.',
  'dialog.successTitle': 'Session download started',
  'dialog.successDescription': 'The browser is downloading the Session ZIP.',
  'dialog.successMarkdownDescription': 'The browser is downloading the Session Markdown transcript.',
  'dialog.errorTitle': 'Session export failed',
  'dialog.close': 'Close',
  'dialog.commandFailed': 'Could not start the Session export.',
}

/** Stable locale keys consumed by the shared modal. */
export type SessionLogDownloadKey = keyof typeof zh
