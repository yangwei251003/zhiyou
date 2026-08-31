import { render, screen } from '@testing-library/react'
import { Field } from './Field'

describe('Field', () => {
  it('associates its visible label and help text with the control', () => {
    render(
      <Field label="项目成果" hint="只填写可以核验的内容">
        <textarea />
      </Field>,
    )

    const control = screen.getByRole('textbox', { name: '项目成果' })
    expect(control).toHaveAccessibleDescription('只填写可以核验的内容')
  })

  it('exposes validation errors without replacing the label', () => {
    render(
      <Field label="岗位名称" error="岗位名称不能为空" required>
        <input />
      </Field>,
    )

    const control = screen.getByRole('textbox', { name: /岗位名称/ })
    expect(control).toHaveAttribute('aria-invalid', 'true')
    expect(control).toHaveAccessibleDescription('岗位名称不能为空')
  })
})
