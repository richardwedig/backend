import { page } from '../app.js';
import { openHelper } from '../helper.js';

const topics = [
  ['⏱️ How do I record the hours I worked?', `
    <p><strong>Way 1 – the stopwatch</strong> (best while you work):</p>
    <ol><li>Press <strong>My Hours</strong> on the left.</li><li>Choose the project.</li><li>Press the green <strong>▶ Start</strong> button.</li><li>When you finish, press the red <strong>⏹ Stop and save</strong> button. Your time is saved for you.</li></ol>
    <p>You can close the website while the stopwatch runs; it keeps counting.</p>
    <p><strong>Way 2 – type it in</strong> (for work you already did):</p>
    <ol><li>Press <strong>My Hours</strong>, then <strong>➕ Add hours by hand</strong>.</li><li>Choose the project and the day, type the number of hours (1.5 means an hour and a half), then press <strong>Save hours</strong>.</li></ol>`],
  ['📁 How do I start a new project?', `
    <ol><li>Press <strong>Projects</strong> on the left.</li><li>Press <strong>➕ New project</strong>.</li><li>Type a name and press <strong>Create project</strong>.</li></ol>
    <p>A folder is made for the project automatically, with <em>Spreadsheets</em>, <em>Documents</em> and <em>Reports</em> folders inside.</p>`],
  ['🧮 How do I keep track of expenses and costs?', `
    <ol><li>Open the project (press <strong>Projects</strong>, then click the project).</li><li>Press <strong>🧮 New spreadsheet</strong> and choose <em>Expenses</em> or <em>Budget</em>.</li><li>Click any box and type. It saves by itself, and number columns are added up at the bottom.</li></ol>
    <p>Already have an Excel file? Use <strong>📎 Add a file</strong>; leave “make Excel files editable” ticked and it becomes a spreadsheet you can change here.</p>`],
  ['🗂️ How do folders work?', `
    <p>Press <strong>Files &amp; Folders</strong>. Click a folder to open it. Inside a folder you can add files, make new folders, and move, rename or delete things using the buttons next to them.</p>
    <p>The main folders are: <strong>Projects</strong> (one folder for each project), <strong>Reports</strong>, <strong>My Documents</strong>, and <strong>Inbox</strong> (where new uploads go if you don’t choose a folder).</p>`],
  ['📅 How do I use the calendar?', `
    <p>Press <strong>Calendar</strong>. Each day shows the hours you worked (in green) and your calendar items. Click a day to see more, or to add hours or a reminder for that day. Use ◀ and ▶ to change month.</p>`],
  ['📊 How do I make a report?', `
    <ol><li>Press <strong>Reports</strong>.</li><li>Choose the kind of report, the project and the dates.</li><li>Choose Word or Excel, then press <strong>📁 Choose folder</strong> to pick where to save it.</li><li>Press <strong>Make the report</strong>.</li></ol>
    <p>Or just ask the Helper, for example: “Make me a Word report of my hours last month and put it in Reports.”</p>`],
  ['♻️ I deleted something by mistake!', `
    <p>Don’t worry. Nothing is really deleted straight away.</p>
    <ol><li>Right after deleting, a message appears at the bottom of the screen with an <strong>↩ Undo</strong> button.</li><li>Or press <strong>Recycle Bin</strong> on the left and press the green <strong>↩ Restore</strong> button next to the item.</li></ol>
    <p>Restoring a project brings back its hours, calendar items, folders and files too.</p>`],
  ['💬 What can the Helper do?', `
    <p>Press <strong>💬 Ask the Helper</strong> at the top of the screen and type your question in plain words. For example:</p>
    <ul><li>“How many hours did I work on the Smith job last week?”</li><li>“Log 3 hours on Smith House for yesterday.”</li><li>“Make me an Excel report of this month’s hours.”</li><li>“Read the document I attached and make a summary.”</li><li>“Where is my mileage spreadsheet?”</li></ul>
    <p>Press <strong>📎 Attach a file</strong> in the Helper to give it a Word document or spreadsheet. If you don’t say where something should be saved, the Helper will ask you.</p>`],
  ['🔎 Making the text bigger', '<p>Use the <strong>Text size</strong> buttons at the bottom of the menu on the left. The biggest “A” makes everything larger. Your choice is remembered.</p>'],
];

export async function render(main) {
  page.context = 'the Help page';
  main.innerHTML = `
    <div class="page-head"><div><h1>Help</h1><p>Click a question to see the answer.</p></div>
      <button class="btn btn-helper btn-big" id="ask">💬 Ask the Helper instead</button></div>
    <div class="help-list">${topics.map(([q, a], i) => `<details ${i === 0 ? 'open' : ''}><summary>${q}</summary>${a}</details>`).join('')}</div>`;
  main.querySelector('#ask').onclick = () => openHelper();
}
