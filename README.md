# Astral Launcher

## Запуск
1. Node.js 20+ и Java (21 для 1.20.5+, 17 для 1.18–1.20.4).
2. `npm install`, затем `npm start`. Установщик: `npm run dist`.

## Что внутри
- Вход через Microsoft (msmc) или по нику, токен хранится зашифрованным.
- Версии Minecraft из манифеста Mojang, Fabric, настройки памяти/Java/окна/папки.
- Несколько сборок со своими папками, переключение и импорт (.mrpack, CurseForge .zip, MultiMC/Prism .zip, папка .minecraft).
- Моды с Modrinth (поиск, установка с обязательными зависимостями, список и удаление).
- Discord Rich Presence (Application ID уже вписан в main.js; картинку `astral` загрузи в Art Assets).
- Докачка модов по своему JSON-манифесту (необязательно).

## Установщик (.exe)
Двойной клик по `build.bat` (нужен Node.js). Через пару минут в папке `dist` появится `Astral-Setup-0.1.0.exe`.
Если ошибка про symbolic link: включи «Режим разработчика» в Windows или запусти build.bat от администратора.
Либо залей проект на GitHub, во вкладке Actions запусти Build Astral и скачай exe из артефактов.
