export function shortcutMatches(event: KeyboardEvent, shortcut: string): boolean {
 const parts=shortcut.toLowerCase().split('+'), key=parts.pop()
 const mac=navigator.platform.includes('Mac')
 const control=parts.includes('control')||parts.includes('ctrl')||(!mac&&parts.includes('commandorcontrol'))
 const command=parts.includes('command')||parts.includes('meta')||(mac&&parts.includes('commandorcontrol'))
 return event.key.toLowerCase()===key && event.ctrlKey===control && event.metaKey===command && event.shiftKey===parts.includes('shift') && event.altKey===parts.includes('alt')
}
export function shortcutLabel(shortcut: string): string {
 return shortcut.replace(/CommandOrControl/g,navigator.platform.includes('Mac')?'⌘':'Ctrl').replace(/Control/g,'Ctrl').replace(/Command/g,'⌘').replace(/\+/g,' ')
}
