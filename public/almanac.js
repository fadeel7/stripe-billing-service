// Fills every year strip with twelve months and marks the current one.
// The strip is decorative-but-informative; the caption carries the meaning.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const now = new Date();

for (const strip of document.querySelectorAll("[data-year-strip]")) {
  strip.innerHTML = "";
  MONTHS.forEach((name, i) => {
    const li = document.createElement("li");
    li.textContent = name.charAt(0);
    li.title = name;
    li.style.setProperty("--m", i);
    if (i < now.getMonth()) li.className = "past";
    if (i === now.getMonth()) {
      li.className = "now";
      li.setAttribute("aria-current", "date");
    }
    strip.append(li);
  });
}

for (const el of document.querySelectorAll("[data-month-name]")) {
  el.textContent = now.toLocaleString("en-US", { month: "long" });
}
for (const el of document.querySelectorAll("[data-year-number]")) {
  el.textContent = now.getFullYear();
}
