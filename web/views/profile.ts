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

// Shown once a nickname is submitted but an admin hasn't approved (or has rejected) it —
// see auth.ts's access gate and views/participants.ts for the admin side.
export function renderPendingScreen(root: HTMLElement) {
  root.innerHTML = `
    <div class="empty-state">
      <p>Заявка отправлена и ждёт одобрения администратора.</p>
      <p style="color:var(--text-muted);font-size:0.85rem">Как только тебя одобрят, здесь появятся лоты.</p>
    </div>
  `;
}

export function renderBannedScreen(root: HTMLElement) {
  root.innerHTML = `
    <div class="empty-state">
      <p>Доступ запрещён.</p>
      <p style="color:var(--text-muted);font-size:0.85rem">Обратись к администратору альянса, если считаешь, что это ошибка.</p>
    </div>
  `;
}
