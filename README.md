# opencode-openai-multi

Плагин для OpenCode, который добавляет ручное переключение между несколькими аккаунтами OpenAI, авторизованными через браузер (ChatGPT Plus/Pro OAuth).

Идея простая:

1. Вы авторизуетесь в OpenCode через `/connect` (OpenAI -> ChatGPT Plus/Pro).
2. Сохраняете текущие OAuth-креды в именованный профиль.
3. Повторяете для других аккаунтов.
4. Переключаете активный аккаунт командой.

## Что делает

- Добавляет команду `/oai` с подкомандами `save/use/list/current/remove`.
- Хранит несколько OAuth-профилей на диске.
- Переключает активные креды провайдера `openai` без изменения моделей/конфига.

## Требования

- OpenCode (2026+) с поддержкой plugins.
- Авторизация OpenAI через `/connect` (OAuth, ChatGPT Plus/Pro).

## Установка

Выполните одну команду в терминале:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/nyxandro/manycodex/main/install.sh)
```

Или, если вы уже клонировали репозиторий:

```bash
chmod +x install.sh && ./install.sh
```

После установки **перезапустите OpenCode**.

## Быстрый старт

**Как добавить несколько аккаунтов:**

1. **Подключите первый аккаунт:**
   Выполните в OpenCode команду `/connect` -> OpenAI -> ChatGPT Plus/Pro. Пройдите авторизацию в браузере.

2. **Сохраните его:**

   ```bash
   /oai save personal
   ```

3. **Смените аккаунт:**
   Снова выполните `/connect`. В браузере **выйдите** из старого аккаунта и войдите во **второй**. OpenCode подцепит новые данные.

4. **Сохраните второй аккаунт:**

   ```bash
   /oai save work
   ```

5. **Переключайтесь:**
   ```bash
   /oai load personal  # переключиться на личный
   /oai load work      # переключиться на рабочий
   ```

## Команды

- `/oai` или `/oai list` — показать список сохраненных профилей.
- `/oai save <name>` — сохранить **текущий** активный аккаунт в профиль с именем `<name>`.
  - Если имя занято, вернется ошибка (защита от перезаписи).
- `/oai load <name>` — загрузить профиль (сделать активным).
  - Алиасы: `/oai use <name>`, `/oai switch <name>` или просто `/oai <name>`.
- `/oai del <name>` — удалить профиль.
  - Алиасы: `/oai rm <name>`, `/oai d <name>`.

## Где хранятся данные

- Активные креды OpenCode: `~/.local/share/opencode/auth.json`
- Профили плагина: `~/.config/opencode/openai-accounts.json`

## Безопасность

В профилях содержатся OAuth-токены.

- НЕ коммитьте `~/.config/opencode/openai-accounts.json` и `~/.local/share/opencode/auth.json`.
- Если токен утек (скрин, лог, paste) — перелогиньтесь через `/connect`.

## Лицензия

MIT (см. `LICENSE`).
