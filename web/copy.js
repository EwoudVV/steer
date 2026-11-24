// Copy buttons on command boxes (.cmd). In the install box, only the command for this
// computer shows. Used by the home page and /me.

const install = document.getElementById("install");
if (install) {
  const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent;
  const mine = /win/i.test(platform) ? "windows" : "unix";
  const others = [...install.querySelectorAll("[data-os]")].filter((el) => el.dataset.os !== mine);
  others.forEach((el) => el.classList.add("hidden"));
  const showAll = document.createElement("button");
  showAll.type = "button";
  showAll.className = "link";
  showAll.textContent = mine === "windows" ? "on a mac or linux?" : "on windows?";
  showAll.addEventListener("click", () => {
    others.forEach((el) => el.classList.remove("hidden"));
    showAll.remove();
  });
  install.append(showAll);
}

for (const cmd of document.querySelectorAll(".cmd")) {
  const code = cmd.querySelector("code");
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "copy";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      copy.textContent = "copied";
    } catch {
      getSelection().selectAllChildren(code);
      copy.textContent = "press ctrl+c";
    }
    setTimeout(() => (copy.textContent = "copy"), 2000);
  });
  cmd.append(copy);
}
