export let token = '';
export async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : {
    method: 'POST', headers: {'Content-Type':'application/json','X-Paper-Token':token}, body: JSON.stringify(data),
    keepalive: path.startsWith('/api/reading/') && new Blob([JSON.stringify(data)]).size < 60000,
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || `HTTP ${response.status}`);
  return value;
}
export function setToken(value) { token = value; }
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const $ = (selector, host=document) => host.querySelector(selector);
export function toast(message) {
  const el = $('#toast'); el.textContent = message; el.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.hidden=true, 4500);
}
