import { LEGAL_DOC_LINKS, legalDocEntries } from '../client/src/legalDocs';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const entries = legalDocEntries();

assert(entries.length === 2, `expected two legal document links, got ${entries.length}`);
assert(LEGAL_DOC_LINKS.terms.href === '/api/about/legal/terms', 'terms link should point to the real legal document API');
assert(LEGAL_DOC_LINKS.privacy.href === '/api/about/legal/privacy', 'privacy link should point to the real legal document API');
assert(entries.some((item) => item.label === '用户协议' && item.href === LEGAL_DOC_LINKS.terms.href), 'entries should include terms link');
assert(entries.some((item) => item.label === '隐私政策' && item.href === LEGAL_DOC_LINKS.privacy.href), 'entries should include privacy link');

console.log('legal-doc-links-client: all assertions passed');
