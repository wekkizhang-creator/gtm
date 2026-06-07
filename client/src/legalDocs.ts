export const LEGAL_DOC_LINKS = {
  terms: {
    label: '用户协议',
    href: '/api/about/legal/terms',
  },
  privacy: {
    label: '隐私政策',
    href: '/api/about/legal/privacy',
  },
} as const;

export function legalDocEntries() {
  return [LEGAL_DOC_LINKS.terms, LEGAL_DOC_LINKS.privacy];
}
