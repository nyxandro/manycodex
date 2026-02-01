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

1. В OpenCode выполните `/connect` и выберите:

- OpenAI -> ChatGPT Plus/Pro

Пройдите браузерную авторизацию.

2. Сохраните первый аккаунт:

```
/oai save personal
```

3. Авторизуйтесь вторым аккаунтом через `/connect` (перелогиньтесь в браузере).

4. Сохраните второй аккаунт:

```
/oai save work
```

5. Переключайтесь:

```
/oai use personal
/oai use work
```

## Команды

- `/oai` — показать меню (список + что делать дальше)
- `/oai <name|number>` — активировать профиль
- `/oai d <number>` — удалить профиль
- `/oai save <name>` — сохранить текущие OAuth-креды `openai` в профиль

## Где хранятся данные

- Активные креды OpenCode: `~/.local/share/opencode/auth.json`
- Профили плагина: `~/.config/opencode/openai-accounts.json`

## Безопасность

В профилях содержатся OAuth-токены.

- НЕ коммитьте `~/.config/opencode/openai-accounts.json` и `~/.local/share/opencode/auth.json`.
- Если токен утек (скрин, лог, paste) — перелогиньтесь через `/connect`.

## Лицензия

MIT (см. `LICENSE`).
