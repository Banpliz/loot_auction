// web/main.ts
import { apiFetch } from './api';
import { renderProfilePrompt } from './views/profile';
import { renderPool } from './views/pool';
import { renderAdmin } from './views/admin';

interface Me {
  telegramId: number;
  username: string | null;
  gameNickname: string | null;
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

  renderShell(root, me);
}

function renderShell(root: HTMLElement, me: Me) {
  root.innerHTML = `
    <nav class="tabs">
      <button data-tab="pool" class="active">Лоты</button>
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
      if (button.getAttribute('data-tab') === 'admin') renderAdmin(content);
      else renderPool(content);
    });
  });
}

main();
