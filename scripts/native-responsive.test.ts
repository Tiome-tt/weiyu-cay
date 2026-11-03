import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it('keeps expensive note writes, renames and fallback payload reads off the native event loop', () => {
  const notes = readFileSync('src-tauri/src/commands/notes.rs','utf8')
  const files = readFileSync('src-tauri/src/commands/files.rs','utf8')
  for (const command of ['save_note','rename_note','backlinks','resolve_link']) expect(notes).toContain(`pub async fn ${command}(`)
  expect(files).toContain('pub async fn read_managed_file(')
})
