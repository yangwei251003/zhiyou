document.querySelectorAll('[data-index]').forEach((button) =>
  button.addEventListener('click', () => {
    const f = window.projectFeatures[Number(button.dataset.index)]
    document
      .querySelectorAll('[data-index]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b === button)))
    document.querySelector('#detail-label').textContent = f[0]
    document.querySelector('#detail-copy').textContent = f[2]
  }),
)
document.querySelectorAll('[data-copy]').forEach((button) =>
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy)
      document.querySelector('#copy-status').textContent = '已复制。请在你的项目目录中运行。'
    } catch {
      document.querySelector('#copy-status').textContent = '请选中上方命令复制。'
    }
  }),
)
