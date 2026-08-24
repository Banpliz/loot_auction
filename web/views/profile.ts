// web/views/profile.ts
import { apiFetch } from '../api';
import { escapeHtml } from '../escape-html';

export function renderProfilePrompt(root: HTMLElement, me: { gameNickname: string | null }, onSaved: () => void) {
  root.innerHTML = `
    <form id="profile-form">
      <label>Твой игровой ник:
        <input name="gameNickname" required value="${escapeHtml(me.gameNickname ?? '')}" />
      </label>
      <button type="submit">Сохранить</button>
      <p id="profile-error" class="error"></p>
    </form>
  `;

  const form = root.querySelector('#profile-form') as HTMLFormElement;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const gameNickname = (new FormData(form).get('gameNickname') as string).trim();
    try {
      await apiFetch('/me', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gameNickname }),
      });
      onSaved();
    } catch (err) {
      (root.querySelector('#profile-error') as HTMLElement).textContent = (err as Error).message;
    }
  });
}
