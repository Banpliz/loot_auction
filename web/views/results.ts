// web/views/results.ts
import { apiFetch } from '../api';
import { escapeHtml } from '../escape-html';
import { colorHex } from '../format';

interface Won {
  name: string;
  color: string;
  imagePath: string;
  quantity: number;
}

interface Participant {
  telegramId: number;
  nickname: string | null;
  won: Won[];
}

const wonLabel = (w: Won) => escapeHtml(w.name) || '<span style="color:var(--text-muted)">без названия</span>';

export async function renderResults(root: HTMLElement, eventId: number, onBack: () => void) {
  root.innerHTML = '<p class="spinner-text">Загрузка…</p>';
  const { results } = (await apiFetch(`/events/${eventId}/results`)) as { results: Participant[] };

  root.innerHTML = `
    <button id="back-btn" class="back-btn">← К лотам</button>
    <section>
      <h3>Итоги аукциона</h3>
      ${
        results.length === 0
          ? '<p class="empty-state">Никто не подавал заявок в этом ивенте.</p>'
          : `<div class="results-list">
              ${results
                .map(
                  (p) => `
                <div class="results-row">
                  <p class="results-row__name">${escapeHtml(p.nickname ?? '—')}</p>
                  ${
                    p.won.length === 0
                      ? '<p class="results-row__won">—</p>'
                      : p.won
                          .map(
                            (w) => `
                        <div class="results-row__item" style="border-left: 3px solid ${colorHex(w.color)}">
                          <img src="/uploads/${w.imagePath}" alt="" />
                          <span>${wonLabel(w)}${w.quantity > 1 ? ` ×${w.quantity}` : ''}</span>
                        </div>`
                          )
                          .join('')
                  }
                </div>`
                )
                .join('')}
            </div>`
      }
    </section>
  `;

  (root.querySelector('#back-btn') as HTMLButtonElement).addEventListener('click', onBack);
}
