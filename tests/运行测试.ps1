$ErrorActionPreference = 'Stop'
$taskNode = 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$env:PDD_NODE_MODULES = 'C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  & $taskNode --test tests/core.test.cjs tests/browser.test.cjs tests/extension.test.cjs tests/batch.test.cjs
  if ($LASTEXITCODE -ne 0) { throw '测试未全部通过' }
} finally { Pop-Location }
