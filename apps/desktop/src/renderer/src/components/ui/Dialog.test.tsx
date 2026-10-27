import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from './Button'
import { Dialog } from './Dialog'

function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>打开来源检查</Button>
      <Dialog
        open={open}
        title="来源检查器"
        description="核对简历表述的事实来源"
        onClose={() => setOpen(false)}
        footer={<Button onClick={() => setOpen(false)}>完成</Button>}
      >
        <button type="button">第一个操作</button>
        <button type="button">最后一个操作</button>
      </Dialog>
    </>
  )
}

describe('Dialog', () => {
  it('has a name, moves focus inside, closes with Escape and restores focus', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: '打开来源检查' })

    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: '来源检查器' })
    expect(dialog).toHaveAccessibleDescription('核对简历表述的事实来源')
    expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})
