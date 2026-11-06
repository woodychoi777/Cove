import { messages } from './translations.js';

export const languages = ['en', 'zh', 'ko', 'ja'];
const storageKey = 'soriseojae.language';
const attributeNames = ['aria-label', 'aria-description', 'title', 'placeholder', 'alt'];
const attributePattern = /\s([a-z][a-z-]*)=("[^"]*"|'[^']*')/gi;

export function selectLocale(preference, systemLanguages = []) {
  if (languages.includes(preference)) return preference;
  for (const candidate of systemLanguages) {
    const primary = String(candidate).toLowerCase().split(/[-_]/)[0];
    if (languages.includes(primary)) return primary;
  }
  return 'en';
}

export function createTranslator(locale) {
  const column = ['en', 'zh', 'ja'].indexOf(locale);
  return (message, ...values) => {
    if (typeof message !== 'string') return message;
    const translated = column < 0 || !Object.hasOwn(messages, message)
      ? message
      : messages[message][column];
    return values.length ? interpolate(translated, values) : translated;
  };
}

function interpolate(message, values) {
  return message.replace(/\{(\d+)\}/g, (token, index) => index < values.length ? String(values[index]) : token);
}

function getPreference() {
  if (typeof document === 'undefined') return null;
  if (globalThis.coveLanguage) return globalThis.coveLanguage.preference;
  try { return localStorage.getItem(storageKey); } catch { return null; }
}

const preference = getPreference();
export const locale = typeof document === 'undefined' ? 'ko'
  : selectLocale(preference, globalThis.coveLanguage?.systemLanguages || navigator.languages);
export const t = createTranslator(locale);
const markupCache = new WeakMap();

function replaceText(value, translate) {
  const content = value.trim();
  return content ? value.replace(content, () => translate(content.replace(/\s+/g, ' '))) : value;
}

function translatePart(message) {
  const slots = [];
  const key = message.replace(/\{\d+\}/g, slot => {
    slots.push(slot);
    return `{${slots.length - 1}}`;
  });
  return t(key, ...slots);
}

// Only the literal parts of a template are translated. Interpolated track titles,
// lyrics, escaped attributes, and markup are substituted after translation.
export function localizeMarkup(parts, ...values) {
  if (locale === 'ko') return String.raw({ raw: parts }, ...values);
  let template = markupCache.get(parts);
  if (!template) {
    template = parts.map((part, index) => part + (index < values.length ? `{${index}}` : '')).join('')
      .replace(/<!--[^]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')+>|[^<]+/g, part => {
        if (!part.startsWith('<')) return replaceText(part, translatePart);
        return part.replace(attributePattern, (match, name, quoted) => {
          if (!attributeNames.includes(name)) return match;
          const quote = quoted[0];
          const value = quoted.slice(1, -1);
          const translated = translatePart(value);
          if (translated === value) return match;
          return match.replace(quoted, () => quote + translated.replaceAll(quote, quote === '"' ? '&quot;' : '&#39;') + quote);
        });
      });
    markupCache.set(parts, template);
  }
  return interpolate(template, values);
}

export function setupLanguage(select) {
  document.documentElement.lang = locale === 'zh' ? 'zh-Hans' : locale;
  if (locale !== 'ko') {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement.closest('script, style')) node.textContent = replaceText(node.textContent, t);
    }
    for (const name of attributeNames) {
      for (const element of document.querySelectorAll(`[${name}]`)) {
        const original = element.getAttribute(name);
        const translated = t(original);
        if (translated !== original) element.setAttribute(name, translated);
      }
    }
  }
  let saved = languages.includes(preference) ? preference : 'system';
  select.value = saved;
  const help = document.querySelector('#language-help');
  select.addEventListener('change', async () => {
    const requested = select.value;
    select.disabled = true;
    try {
      if (globalThis.coveLanguage) {
        const result = await globalThis.coveLanguage.save(requested);
        if (!result.ok) throw Error(result.error);
      } else {
        localStorage.setItem(storageKey, requested);
      }
      saved = requested;
      help.textContent = t('Cove를 다시 열면 언어가 적용됩니다.');
    } catch {
      select.value = saved;
      help.textContent = t('언어 설정을 저장하지 못했습니다.');
    } finally {
      select.disabled = false;
    }
  });
}
