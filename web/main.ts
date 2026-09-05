// web/main.ts
import { apiFetch } from './api';
import { renderProfilePrompt, renderPendingScreen, renderBannedScreen } from './views/profile';
import { renderPool } from './views/pool';
import { renderAdmin } from './views/admin';
import { renderParticipants } from './views/participants';

interface Me {
  telegramId: number;
  username: string | null;
  gameNickname: string | null;
  status: 'pending' | 'approved' | 'banned';
  isAdmin: boolean;
}

async function main() {
  const root = document.getElementById('app')!;
  root.textContent = 'Загрузка...';

  let me: Me;
  try {
    me = await apiFetch('/me');
  } catch (err) {
    root.textContent = `Ошибка: ${(err as Error).message}`;
    return;
  }

  if (!me.gameNickname) {
    renderProfilePrompt(root, me, () => main());
    return;
  }

  // Admins are force-approved server-side on every request (see auth.ts), so this branch
  // never actually gates an admin out — it only ever applies to regular participants.
  if (!me.isAdmin && me.status === 'pending') {
    renderPendingScreen(root);
    return;
  }
  if (!me.isAdmin && me.status === 'banned') {
    renderBannedScreen(root);
    return;
  }

  renderShell(root, me);
}

function renderShell(root: HTMLElement, me: Me) {
  root.innerHTML = `
    <nav class="tabs">
      <button data-tab="pool" class="active">Лоты</button>
      ${me.isAdmin ? '<button data-tab="participants">Заявки</button>' : ''}
      ${me.isAdmin ? '<button data-tab="admin">Админ</button>' : ''}
    </nav>
    <div id="tab-content"></div>
  `;
  const content = root.querySelector('#tab-content') as HTMLElement;
  renderPool(content);

  root.querySelectorAll('nav button').forEach((button) => {
    button.addEventListener('click', () => {
      root.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      const tab = button.getAttribute('data-tab');
      if (tab === 'admin') renderAdmin(content);
      else if (tab === 'participants') renderParticipants(content);
      else renderPool(content);
    });
  });
}

main();
