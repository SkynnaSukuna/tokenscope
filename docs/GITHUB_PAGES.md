# Размещение TokenScope на GitHub Pages

[Главная инструкция](../README.md) · [API локального режима](API.md) · [Выбор лицензии](LICENSING.md)

Инструкция рассчитана на новый публичный репозиторий **`tokenscope`**, основную ветку **`main`** и workflow **`.github/workflows/pages.yml`**. Для публичных репозиториев GitHub Pages доступен в GitHub Free; возможность публикации из приватного репозитория зависит от плана. [Источник GitHub](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

## 1. Проверить проект перед загрузкой

Нужны Git, Node.js 24 и учётная запись GitHub. Команды выполняются в корне проекта.

```bash
npm test
npm run test:pages
npm run build
npm run preview
```

Предпросмотр: <http://127.0.0.1:4173/tokenscope/>. `npm run build` работает без сети и берёт локальный кэш; без кэша будет пустой каталог с честным состоянием «нет данных».

Если нужен новый снимок с FunPay, остановите предпросмотр через `Ctrl+C` и выполните:

```bash
npm run snapshot
npm run preview
```

Точный контракт: `npm run snapshot` запускает **`node tools/collect-snapshot.js && npm run build`**. Сначала собираются публичные данные в локальные `data/cache.json`, историю и описания, затем создаётся `dist/`. Сам `npm run build` сетевой сбор не запускает.

Перед отправкой просмотрите `.gitignore`. Не загружайте исходные `data/`, `dist/`, секреты, cookies, ключи, приватные сообщения, логи, скриншоты и локальные папки `.probe/`/`.tmp/`. Статический снимок содержит только публичные данные, подготовленные сборкой; всё попавшее в него станет доступно посетителям сайта. Публикуемый `dist/` также проверьте перед размещением.

## 2. Создать репозиторий на GitHub

1. В GitHub нажмите **+ → New repository**.
2. Укажите **Repository name: `tokenscope`**, видимость **Public**.
3. **Не добавляйте** README, `.gitignore` или лицензию на странице создания: подготовленные файлы уже есть в проекте, включая `LICENSE`.
4. Нажмите **Create repository**.

MIT уже добавлена как исходный выбор для открытого проекта. До публикации подтвердите, что этот выбор соответствует вашим правам и намерениям: [пояснение и альтернативы](LICENSING.md).

## 3. Загрузить исходники через Git

Этот вариант рекомендуется: он сохраняет структуру и включает скрытую папку `.github`.

Для папки, которая ещё не является Git-репозиторием:

```bash
git init
git branch -M main
git status --short --ignored
```

Проверьте вывод до добавления файлов. В строках исходников должны быть `README.md`, `LICENSE`, `package.json`, `server.js`, папки `lib/`, `public/`, `tools/`, `docs/` и `.github/`. Локальные кэши, артефакты и диагностика должны быть исключены.

Затем добавьте только исходники проекта:

```bash
git add .gitignore .nvmrc .github README.md LICENSE package.json server.js lib public tools docs
git status --short
git diff --cached --stat
```

Если в проекте появился `package-lock.json`, добавьте его отдельно командой `git add package-lock.json`. Не выполняйте следующий шаг, пока список подготовленных файлов не проверен.

Замените **`YOUR_USERNAME`** в адресе ниже своим логином или именем организации GitHub:

```bash
git commit -m "Prepare TokenScope for GitHub Pages"
git remote add origin https://github.com/YOUR_USERNAME/tokenscope.git
git push -u origin main
```

Это команды для самостоятельной публикации владельцем. Если папка уже под Git, не инициализируйте её заново: проверьте текущую ветку и remote перед отправкой. Для HTTPS используйте настроенный Git Credential Manager, GitHub CLI или токен согласно [официальной инструкции по аутентификации](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github). Не помещайте токен в URL репозитория или файлы проекта.

## Вариант: загрузка через браузер

В новом репозитории откройте **uploading an existing file** либо **Add file → Upload files** и загрузите исходники с той же структурой. В корне должны оказаться `package.json` и `server.js`, а не дополнительная внешняя папка с проектом.

Проверьте, что существует именно **`.github/workflows/pages.yml`**. Папка начинается с точки: она может быть скрыта в проводнике или пропущена при выборе файлов. Если её загрузить не получилось, создайте файл через **Add file → Create new file**, задайте путь `.github/workflows/pages.yml` и вставьте полное содержимое локального workflow. После этого сравните файл на GitHub с локальным. Не заменяйте его общим шаблоном Jekyll.

Кэш, `dist/`, секреты, логи и скриншоты через браузер также не загружайте. Если приходится передавать много вложенных папок или скрытые файлы теряются, используйте Git.

## 4. Включить публикацию Pages

1. Откройте репозиторий на GitHub.
2. Перейдите в **Settings → Pages**.
3. В блоке **Build and deployment**, поле **Source**, выберите **GitHub Actions**.
4. Дополнительный шаблон workflow не создавайте: в проекте уже есть `.github/workflows/pages.yml`.
5. Перейдите во вкладку **Actions**, выберите workflow из `pages.yml` и выполните **Run workflow → main → Run workflow**, если первый push произошёл до настройки Pages.
6. Дождитесь успешной сборки и deployment. Готовый адрес смотрите в **Settings → Pages** или в результате шага публикации.

Для такого репозитория стандартный адрес имеет вид `https://YOUR_USERNAME.github.io/tokenscope/`. Это пример: настоящий адрес показывает GitHub. Путь `/tokenscope/` важен при проверке сайта проекта.

Официальная настройка: [Configuring a publishing source for your GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

## Как происходит обновление

Workflow `.github/workflows/pages.yml` запускается:

- при push в `main`;
- вручную через **Actions → Run workflow**;
- по расписанию `13,43 * * * *`, то есть в 13-ю и 43-ю минуту каждого часа по UTC.

В workflow используется Node.js 24. Порядок шагов: восстановление данных через `actions/cache/restore` → тесты → сбор каталога (`node tools/collect-snapshot.js`) → сохранение данных через `actions/cache/save` → сборка (`npm run build`) → загрузка и публикация `dist/`. Сохранение происходит только после успешного сбора; последующая ошибка сборки или загрузки сайта уже не помешает сохранить собранные данные в кэш. Для публикации используются официальные `actions/configure-pages`, `actions/upload-pages-artifact` и `actions/deploy-pages`. Версии действий находятся в workflow; при обновлении сверяйте их с официальными репозиториями.

Для каждой из шести категорий нужны свежие лоты либо пригодный кэш с исходной датой. При частичной ошибке сбора старые данные этой категории сохраняются, а их даты остаются видимыми. Если хотя бы одна категория осталась без пригодных данных, запуск завершается ошибкой **до записи снимка и публикации**. Это защищает и первую публикацию, и уже работающий сайт после потери кэша. Полностью недоступная сеть допускается только при наличии пригодных сохранённых данных для всех категорий. Предыдущий опубликованный сайт от неудачного запуска не обновится.

**Actions cache не заменяет резервную копию.** При его удалении или утрате следующий успешный запуск должен заново собрать все категории; история цен начнёт накапливаться с этого момента. Сам опубликованный сайт продолжит показывать прежний снимок до следующей успешной публикации. Локальные данные для собственного архива можно сохранять отдельно, не добавляя их в публичный репозиторий.

Локальная команда `npm run build` допускает пустую сборку для проверки интерфейса. Это отличается от требования иметь пригодные данные при автоматической первой публикации.

### Как проверить свежесть

В `dist/snapshot.json` и на опубликованном сайте используются сведения о снимке:

| Поле | Значение |
| --- | --- |
| `updatedAt` | Время данных последнего удачного обновления |
| `builtAt` | Время создания статической сборки |
| `lastAttemptAt` | Время последней попытки сбора |
| `partial` | Есть неполнота данных |
| `refreshError` | Ошибка обновления, если она была |
| `updatedAt` отдельной категории | Свежесть конкретной части каталога |

Более позднее `builtAt` не означает, что все цены стали новыми. При частичном обновлении сравнивайте также даты категорий и сообщение об ошибке.

Расписание — попытка запуска, без гарантии обновления ровно через 30 минут. GitHub указывает, что плановые запуски могут задерживаться или теряться при нагрузке; они выполняются из default branch. Поэтому оставьте `main` основной веткой и проверяйте историю Actions. [Официальная документация `schedule`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

### Что работает на Pages

Фильтры, сортировка, статистика, сохранённые описания и история обрабатываются локально в браузере по опубликованным данным. Кнопка обновления перечитывает этот снимок; она не запускает Actions и не запрашивает FunPay напрямую.

GitHub Pages не запускает `server.js` и не обслуживает живой серверный API. Новые отзывы продавца внутри статического сайта не загружаются: используйте внешнюю ссылку на профиль FunPay. Проверка отсутствия оценок 1–3★ в этой сборке отключена. Если такой фильтр остался в старой ссылке, выдача будет пустой с пояснением; снимите это условие. Для полной работы с отзывами и их фильтрами запустите `npm start` на своём компьютере. [Что такое GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

## Если что-то не работает

### Workflow не появился или Actions выключен

Проверьте наличие `.github/workflows/pages.yml` в `main`. Откройте **Settings → Actions → General** и проверьте, разрешён ли GitHub Actions; политика организации может ограничивать запуск и доступные действия. После разрешения откройте **Actions** и запустите workflow вручную. [Настройки Actions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)

### Публикация завершилась ошибкой

Откройте красный запуск в **Actions** и найдите первый упавший шаг. При ошибке Pages проверьте **Settings → Pages → Source → GitHub Actions**. Workflow публикации должен иметь `pages: write`, `id-token: write` и окружение `github-pages`; политики окружения могут ограничивать ветки deployment. Эти настройки описаны в [официальном руководстве по custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

При ошибке получения FunPay проверьте, есть ли пригодный предыдущий кэш, и повторите запуск позже. Сообщение «Неполный каталог» перечисляет категории без свежих и сохранённых лотов: публикация остановлена, старый сайт остаётся доступным. Не обходите ограничения источника авторизационными cookies или секретами в публичном снимке. Без пригодного кэша для первой публикации нужен успешный сбор всех шести категорий.

### Открывается 404 или страница без оформления

Проверьте ссылку из **Settings → Pages**, наличие успешного deployment и путь `/tokenscope/`. Не выбирайте публикацию из `/docs`: там находится документация проекта, а артефакт сайта создаётся в `dist/`. Локально сравните результат `npm run build` + `npm run preview`. Официальная справка: [Troubleshooting 404 errors](https://docs.github.com/en/pages/getting-started-with-github-pages/troubleshooting-404-errors-for-github-pages-sites).

### Цены старые или автоматические запуски прекратились

Проверьте даты снимка и категорий, сообщения о неполноте и последние запуски Actions. Кнопка обновления в браузере не создаёт новый снимок. Запустите workflow вручную и посмотрите результат сборщика.

В публичном репозитории GitHub автоматически отключает плановые workflows после **60 дней без активности репозитория**; после fork они изначально отключены. При таком сообщении откройте **Actions**, выберите workflow и включите его снова. Это правило подтверждено в [официальной документации GitHub](https://github.com/github/docs/blob/main/data/reusables/actions/scheduled-workflows-disabled.md). Включение и выключение workflows: [официальная инструкция](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows).

### В каталоге нет предложений

Сначала сбросьте фильтры: точный объём, выбранные модели, ограничения отзывов и скрытые продавцы могут оставить пустую выдачу. Затем проверьте наличие снимка и даты сбора. Отсутствующий кэш при ручной `npm run build` создаёт честную пустую выдачу. На Pages с неудачным первым сбором публикации ещё не будет — проверьте Actions.

## Первичные источники

Документация сверена 26 ноября 2026 года. Интерфейс GitHub и условия сервиса могут изменяться.

- [GitHub Pages: что публикуется](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [Источник публикации и GitHub Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [Custom workflows и официальные Pages actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Плановые запуски `schedule`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Автоотключение расписания: исходник документации GitHub](https://github.com/github/docs/blob/main/data/reusables/actions/scheduled-workflows-disabled.md)
- [Управление GitHub Actions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)
