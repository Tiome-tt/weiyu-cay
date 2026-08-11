import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface GenerateSearchFixtureOptions {
  count: number
  outputRoot: string
  seed: number
}

export interface SearchFixtureResult {
  noteCount: number
  outputRoot: string
}

interface FixtureNote {
  id: string
  title: string
  tags: string[]
}

const FIXTURE_TIMESTAMP = '2026-07-30T15:30:00.000Z'
const FIXTURE_EPOCH_MS = Date.parse(FIXTURE_TIMESTAMP)
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/8QAAAABJRU5ErkJggg==', 'base64')
const ADJECTIVES = ['Amber', 'Calm', 'Cedar', 'Dawn', 'Fern', 'Golden', 'Harbor', 'Ivy', 'Juniper', 'Moss']
const SUBJECTS = ['Archive', 'Backlog', 'Checklist', 'Design', 'Experiment', 'Garden', 'Notebook', 'Outline', 'Project', 'Review']
const TAGS = ['backend', 'design', 'ideas', 'important', 'planning', 'research', 'rust', 'search', 'testing', 'typescript']

class SeededRandom {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  next(): number {
    this.state = (this.state * 1664525 + 1013904223) >>> 0
    return this.state
  }

  below(upperBound: number): number {
    return this.next() % upperBound
  }
}

function uuidV7(timestamp: number, random: SeededRandom): string {
  const bytes = new Uint8Array(16)
  for (let offset = 5; offset >= 0; offset -= 1) {
    bytes[offset] = Math.floor(timestamp / 256 ** (5 - offset)) % 256
  }
  for (let offset = 6; offset < bytes.length; offset += 1) bytes[offset] = random.below(256)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function assertSafeOptions(options: GenerateSearchFixtureOptions): void {
  if (!Number.isSafeInteger(options.count) || options.count < 1) {
    throw new Error('--count must be a positive safe integer.')
  }
  if (!Number.isSafeInteger(options.seed)) throw new Error('--seed must be a safe integer.')
  if (existsSync(options.outputRoot) && readdirSync(options.outputRoot).length > 0) {
    throw new Error(`Refusing to overwrite non-empty fixture root: ${basename(options.outputRoot)}`)
  }
}

function markdownFor(note: FixtureNote, folderId: string, target: FixtureNote | undefined, index: number): string {
  const tagLines = note.tags.map((tag) => `  - ${tag}`).join('\n')
  const link = target === undefined ? `[[${note.title}|${note.id}]]` : `[[${target.title}|${target.id}]]`
  return `---\nid: ${note.id}\ntitle: ${note.title}\nfolderId: ${folderId}\ntags:\n${tagLines}\ncreatedAt: ${FIXTURE_TIMESTAMP}\nupdatedAt: ${FIXTURE_TIMESTAMP}\n---\n\n## ${note.title}\n\nThis deterministic search fixture note ${index + 1} mentions Markdown, local-first storage, and ${note.tags.join(', ')}.\n\nRelated note: ${link}.\n\n![Fixture image](assets/fixture-${index + 1}.png)\n`
}

/** Generates only into an empty caller-selected directory so fixture runs cannot overwrite notes. */
export function generateSearchFixture(options: GenerateSearchFixtureOptions): SearchFixtureResult {
  assertSafeOptions(options)
  const outputRoot = resolve(options.outputRoot)
  mkdirSync(outputRoot, { recursive: true })
  const random = new SeededRandom(options.seed)
  const folders = ['Inbox', 'Projects', 'Research'].map((_, index) => uuidV7(FIXTURE_EPOCH_MS + index, random))
  const notes: FixtureNote[] = Array.from({ length: options.count }, (_, index) => ({
    id: uuidV7(FIXTURE_EPOCH_MS + index + folders.length, random),
    title: `${ADJECTIVES[random.below(ADJECTIVES.length)]} ${SUBJECTS[random.below(SUBJECTS.length)]} ${index + 1}`,
    tags: [TAGS[random.below(TAGS.length)], TAGS[random.below(TAGS.length)]],
  })).map((note) => ({ ...note, tags: [...new Set(note.tags)] }))

  for (const [index, note] of notes.entries()) {
    const noteRoot = join(outputRoot, 'notes', note.id)
    mkdirSync(join(noteRoot, 'assets'), { recursive: true })
    const target = index === 0 ? undefined : notes[random.below(index)]
    writeFileSync(join(noteRoot, 'note.md'), markdownFor(note, folders[index % folders.length], target, index), 'utf8')
    writeFileSync(join(noteRoot, 'assets', `fixture-${index + 1}.png`), PNG_1X1)
  }

  return { noteCount: notes.length, outputRoot }
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function parseIntegerOption(name: string, defaultValue: number): number {
  const value = optionValue(name)
  if (value === undefined) return defaultValue
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an unsigned integer.`)
  return Number(value)
}

function runCommand(): void {
  const count = parseIntegerOption('--count', 10_000)
  const seed = parseIntegerOption('--seed', 20260730)
  const output = optionValue('--output')
  const outputRoot = output === undefined
    ? join(tmpdir(), `simple-notes-search-fixture-${seed}-${Date.now()}`)
    : resolve(output)
  const result = generateSearchFixture({ count, outputRoot, seed })
  console.log(`Generated ${result.noteCount} notes in ${result.outputRoot}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runCommand()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Fixture generation failed.')
    process.exitCode = 1
  }
}
