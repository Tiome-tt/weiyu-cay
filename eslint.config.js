import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.worktrees/**', 'public/pdfjs/**', 'src-tauri/target/**', 'src-tauri/target-*/**'],
  },
  ...tseslint.configs.recommended,
)
