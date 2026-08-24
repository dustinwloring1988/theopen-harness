/** `settings.notify` namespace dictionaries: the General-section row's copy and the toast titles. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'notify.title': '桌面通知',
  'notify.description': '回合结束或智能体被审批阻塞时弹出系统通知；页面在前台时不打扰。',
  'notify.mode.ask': '首次询问',
  'notify.mode.on': '开启',
  'notify.mode.off': '关闭',
  'notify.quiet.title': '免打扰时段',
  'notify.quiet.description': '该时段内不弹系统通知（可选）。',
  'notify.quietFrom': '开始',
  'notify.quietTo': '结束',
  'notify.completed.title': '回合已完成',
  'notify.approval.title': '等待你的审批',
} satisfies Record<string, string>

/** The settings.notify namespace key union. */
export type NotifyKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'notify.title': 'Desktop notifications',
  'notify.description':
    'Raise an OS notification when a turn finishes or an agent is blocked on approval; silent while the tab is focused.',
  'notify.mode.ask': 'Ask on first event',
  'notify.mode.on': 'On',
  'notify.mode.off': 'Off',
  'notify.quiet.title': 'Quiet hours',
  'notify.quiet.description': 'No OS notifications inside this window (optional).',
  'notify.quietFrom': 'From',
  'notify.quietTo': 'To',
  'notify.completed.title': 'Turn completed',
  'notify.approval.title': 'Approval needed',
} satisfies Record<NotifyKey, string>
