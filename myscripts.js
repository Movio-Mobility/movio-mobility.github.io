
const button = document.querySelector('#menu-button');
const menu = document.querySelector('#menu');


button.addEventListener('click', () => {
    console.log("click");
  menu.classList.toggle('hidden');
});
