#!/bin/bash
# Скрипт установки плагина opencode-openai-multi
# Используется для автоматической установки из репозитория GitHub или локальной папки.

# Завершаем выполнение при любой ошибке
set -e

# Цвета для вывода
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Пути к файлам в репозитории (для скачивания)
BASE_URL="https://raw.githubusercontent.com/nyxandro/manycodex/main"
PLUGIN_FILE="plugins/openai-multi.ts"
CMD_FILE="commands/oai.md"

# Целевые директории OpenCode (global install)
#
# Почему так:
# - OpenCode по документации грузит global plugins из `~/.config/opencode/plugins/`.
# - На Linux/WSL/macOS принято уважать XDG, поэтому используем XDG_CONFIG_HOME,
#   а если он не задан — стандартный `~/.config`.
if [ -z "${XDG_CONFIG_HOME:-}" ] && [ -z "${HOME:-}" ]; then
    echo -e "${RED}[ERR] Не задан HOME или XDG_CONFIG_HOME. Невозможно определить папку конфигурации OpenCode.${NC}"
    exit 1
fi

XDG_CONFIG_HOME_FALLBACK="${XDG_CONFIG_HOME:-${HOME}/.config}"

CONFIG_DIR="$XDG_CONFIG_HOME_FALLBACK/opencode"
DEST_PLUGIN_DIR="$CONFIG_DIR/plugins"
DEST_CMD_DIR="$CONFIG_DIR/commands"

echo -e "${BLUE}=== Установка плагина OpenCode OpenAI Multi-Account ===${NC}"

# 1. Проверяем и создаем директории
echo -e "${BLUE}[INF] Проверка директорий...${NC}"
if [ ! -d "$DEST_PLUGIN_DIR" ]; then
    echo -e "Создание директории: $DEST_PLUGIN_DIR"
    mkdir -p "$DEST_PLUGIN_DIR"
fi

if [ ! -d "$DEST_CMD_DIR" ]; then
    echo -e "Создание директории: $DEST_CMD_DIR"
    mkdir -p "$DEST_CMD_DIR"
fi

# 2. Функция для скачивания или копирования файла
install_file() {
    local rel_path=$1
    local dest_dir=$2
    local filename=$(basename "$rel_path")
    local dest_path="$dest_dir/$filename"

    # Проверяем, запущен ли скрипт локально и существует ли файл рядом
    # (простая проверка: если мы внутри корня репо)
    if [ -f "./$rel_path" ]; then
        echo -e "${GREEN}[LOC] Копирование локального файла $rel_path -> $dest_path${NC}"
        cp "./$rel_path" "$dest_path"
    else
        # Иначе скачиваем с GitHub
        local url="$BASE_URL/$rel_path"
        echo -e "${BLUE}[NET] Скачивание $url -> $dest_path${NC}"
        
        # Используем curl, падаем при ошибке (-f), следуем редиректам (-L), молча (-s), но показываем ошибки (-S)
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL "$url" -o "$dest_path"
        elif command -v wget >/dev/null 2>&1; then
            wget -qO "$dest_path" "$url"
        else
            echo -e "${RED}[ERR] Не найден curl или wget. Установка невозможна.${NC}"
            exit 1
        fi
    fi
}

# 3. Устанавливаем файлы
install_file "$PLUGIN_FILE" "$DEST_PLUGIN_DIR"
install_file "$CMD_FILE" "$DEST_CMD_DIR"

# 4. Финиш
echo -e "${GREEN}=== Установка успешно завершена! ===${NC}"
echo -e "Для применения изменений:${NC}"
echo -e "1. Перезапустите OpenCode."
echo -e "2. Используйте команду ${GREEN}/oai${NC} для настройки."
