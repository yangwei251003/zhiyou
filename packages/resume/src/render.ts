import type { ResumeDocument, ResumeTemplate } from './model.js'

const BASE_STYLES = `
    * { box-sizing: border-box; }
    html { background: #ffffff; }
    body { margin: 0; font-size: 10.5pt; line-height: 1.48; }
    .resume-header { break-inside: avoid; }
    h1 { margin: 0; }
    h2 { break-after: avoid; }
    section { break-inside: auto; }
    ul { margin: 0; padding-left: 5mm; }
    li { break-inside: avoid; }
  `

const TEMPLATE_STYLES: Readonly<Record<ResumeTemplate, string>> = {
  ats_single_column: `
    @page { size: A4; margin: 14mm 16mm; }
    body { font-family: Arial, "Noto Sans SC", sans-serif; color: #111827; }
    .resume-header { border-bottom: 1.25pt solid #111827; padding-bottom: 3mm; margin-bottom: 4mm; }
    h1 { font-size: 19pt; line-height: 1.15; margin-bottom: 2mm; }
    .contact { color: #374151; font-size: 9.5pt; }
    h2 { color: #111827; font-size: 11.5pt; line-height: 1.2; border-bottom: 0.75pt solid #9ca3af; padding-bottom: 1.3mm; margin: 4.5mm 0 2mm; }
    li { margin: 1.3mm 0; }
  `,
  professional: `
    @page { size: A4; margin: 13mm 17mm 15mm; }
    body { font-family: "Segoe UI", "Noto Sans SC", sans-serif; color: #172a3a; border-top: 2.4mm solid #0f6674; padding-top: 4mm; }
    .resume-header { padding-bottom: 3.5mm; margin-bottom: 4mm; border-bottom: 0.6pt solid #a9c6cc; }
    h1 { color: #123f52; font-size: 21pt; line-height: 1.12; letter-spacing: 0.02em; margin-bottom: 2.2mm; }
    .contact { color: #46616b; font-size: 9.5pt; letter-spacing: 0.01em; }
    h2 { color: #0f6674; font-size: 12pt; line-height: 1.2; border-left: 2.5mm solid #1c8995; border-bottom: 0.5pt solid #c6dadd; padding: 1mm 0 1mm 2.5mm; margin: 5mm 0 2mm; }
    li { margin: 1.5mm 0; padding-left: 0.6mm; }
    li::marker { color: #1c8995; }
  `,
  campus_project: `
    @page { size: A4; margin: 13mm 16mm 15mm; }
    body { font-family: "Noto Sans SC", "Segoe UI", sans-serif; color: #22263a; border-top: 1.2mm solid #5b57c8; padding-top: 3mm; }
    .resume-header { background: #f2f1fb; border-left: 2mm solid #5b57c8; padding: 3.5mm 4mm; margin-bottom: 4.5mm; }
    h1 { color: #302d78; font-size: 20pt; line-height: 1.15; margin-bottom: 2mm; }
    .contact { color: #565676; font-size: 9.5pt; }
    h2 { color: #373486; background: #f7f6fd; font-size: 11.75pt; line-height: 1.2; border-bottom: 1pt solid #b9b6e9; padding: 1.2mm 2mm; margin: 4.8mm 0 2mm; }
    li { margin: 1.55mm 0; padding-left: 0.8mm; }
    li::marker { color: #e07a45; }
  `,
}

function resolveTemplate(template: unknown): ResumeTemplate {
  if (template === 'professional' || template === 'campus_project') {
    return template
  }
  return 'ats_single_column'
}

function resolveLanguage(language: unknown): ResumeDocument['language'] {
  return language === 'en-US' ? 'en-US' : 'zh-CN'
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export function toAtsText(resume: ResumeDocument): string {
  const contact = [
    resume.contact.phone,
    resume.contact.email,
    resume.contact.location,
    ...resume.contact.links,
  ].filter(Boolean)
  const sections = resume.sections.flatMap((section) => [
    section.title,
    ...section.claims.map((claim) => `• ${claim.text}`),
  ])
  return [resume.candidateName, contact.join(' | '), ...sections].filter(Boolean).join('\n')
}

export function toSafeHtml(resume: ResumeDocument): string {
  const template = resolveTemplate(resume.template)
  const language = resolveLanguage(resume.language)
  const sections = resume.sections
    .map(
      (section) => `<section>
        <h2>${escapeHtml(section.title)}</h2>
        <ul>${section.claims.map((claim) => `<li>${escapeHtml(claim.text)}</li>`).join('')}</ul>
      </section>`,
    )
    .join('')
  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:" />
  <style>
${BASE_STYLES}
${TEMPLATE_STYLES[template]}
  </style>
</head>
<body class="resume template-${template}" data-template="${template}">
  <header class="resume-header">
    <h1>${escapeHtml(resume.candidateName)}</h1>
    <div class="contact">${escapeHtml(
      [resume.contact.phone, resume.contact.email, resume.contact.location, ...resume.contact.links]
        .filter(Boolean)
        .join(' · '),
    )}</div>
  </header>
  <main>${sections}</main>
</body>
</html>`
}

export interface ResumeExporter {
  readonly format: 'pdf' | 'docx' | 'html' | 'markdown' | 'text'
  export(resume: ResumeDocument): Promise<Uint8Array>
}

export class HtmlResumeExporter implements ResumeExporter {
  readonly format = 'html' as const
  export(resume: ResumeDocument): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode(toSafeHtml(resume)))
  }
}

export class TextResumeExporter implements ResumeExporter {
  readonly format = 'text' as const
  export(resume: ResumeDocument): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode(toAtsText(resume)))
  }
}
