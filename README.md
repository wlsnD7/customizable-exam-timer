# Customizable Exam Timer

[中文](#中文) | [English](#english)

## 中文

一个给学校考试用的倒计时网页，设置好考试时间后全屏，到点弹出提醒，也可以播放声音。

### 功能

- **两种计时方式**：按时刻（如 09:00–11:00，到点自动开考）或按时长（如 120 分钟，手动开始）
- **交卷离场限制**：例如“开考 30 分钟内不得交卷离场”“考试结束前 15 分钟内不得交卷离场”，大屏会显示当前状态，进度条上标出禁止交卷的时段，到点自动提醒
- **到点提醒**：开考时、可以交卷时、停止交卷时、结束前 N 分钟、结束时，共五个固定的提醒，每个都可以单独开关，并设置提示文字和声音
- **学校信息**：学校 Logo、学校名称、考试名称、考场须知

### 使用

1. 下载本项目并解压
2. 双击 `index.html`，用浏览器打开
3. 填写考试信息，点击“进入考场模式”，按 `F` 键全屏

在线使用：https://wlsnd7.github.io/customizable-exam-timer/

快捷键（考场模式）：`F` 全屏，`空格` / `回车` 开始考试（按时长模式）。

### 说明

- 所有设置、Logo 和音频都只保存在当前浏览器里
- 浏览器要求页面被点击过才能播放声音，页面刷新后需要点击一下启用声音
- 计时以电脑系统时间为准

## English

A countdown page for school exams: set up the exam time, go full screen, and get on-screen reminders, with optional sound, when each time comes.

### Features

- **Two timing modes**: fixed times (e.g. 09:00–11:00, starts automatically) or duration
- **Leaving rules**: e.g. "no leaving during the first 30 minutes" and "no leaving during the last 15 minutes", shown as a status line and as shaded periods on the progress bar, with an automatic reminder when the time comes
- **Reminders** at five fixed points: the start, when candidates may start leaving, when leaving stops, N minutes before the end, and the end. Each can be turned off and has its own message and sound
- **School branding**: logo, school name, exam name, and notes for candidates

### Usage

1. Download this project and unzip it
2. Open `index.html` in a browser
3. Fill in the exam details, click "Enter exam mode", and press `F` for full screen

Use it online: https://wlsnd7.github.io/customizable-exam-timer/

Shortcuts in exam mode: `F` toggles full screen, `Space` / `Enter` starts the exam in duration mode.

### Notes

- Settings, logo, and audio are stored only in the current browser
- Browsers only allow sound after the page has been clicked. If the page is reloaded mid-exam, it asks for one click to turn sound back on
- Timing follows the computer's system clock

## License

[MIT](LICENSE)
