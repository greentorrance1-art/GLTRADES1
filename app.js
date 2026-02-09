// JOURNAL LOGIC
const journalText = document.getElementById("journalText");
const journalList = document.getElementById("journalList");
const saveJournal = document.getElementById("saveJournal");
const journalType = document.getElementById("journalType");
const emotionEls = document.querySelectorAll(".emotions span");

let selectedEmotion = null;
let journals = JSON.parse(localStorage.getItem("journals")) || [];

emotionEls.forEach(e => {
  e.onclick = () => {
    emotionEls.forEach(x => x.classList.remove("active"));
    e.classList.add("active");
    selectedEmotion = e.dataset.value;
  };
});

function renderJournal() {
  journalList.innerHTML = "";
  journals.forEach(j => {
    const li = document.createElement("li");
    li.textContent = `${j.type} | Emotion ${j.emotion} | ${j.text}`;
    journalList.appendChild(li);
  });
}

saveJournal.onclick = () => {
  if (!journalText.value || !selectedEmotion) return;

  journals.unshift({
    type: journalType.value,
    text: journalText.value,
    emotion: selectedEmotion
  });

  localStorage.setItem("journals", JSON.stringify(journals));
  journalText.value = "";
  selectedEmotion = null;
  emotionEls.forEach(x => x.classList.remove("active"));
  renderJournal();
};

renderJournal();
