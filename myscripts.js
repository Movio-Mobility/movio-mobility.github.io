(function() {
    var button = document.querySelector('#menu-button');
    var menu = document.querySelector('#menu');
    if (!button || !menu) return;

    function openMenu() {
        menu.classList.add('menu-open');
        button.classList.add('open');
        document.body.style.overflow = 'hidden';
    }

    function closeMenu() {
        menu.classList.remove('menu-open');
        button.classList.remove('open');
        document.body.style.overflow = '';
    }

    button.addEventListener('click', function(e) {
        e.stopPropagation();
        if (menu.classList.contains('menu-open')) {
            closeMenu();
        } else {
            openMenu();
        }
    });

    menu.querySelectorAll('a').forEach(function(link) {
        link.addEventListener('click', closeMenu);
    });

    document.addEventListener('click', function(e) {
        if (menu.classList.contains('menu-open') &&
            !menu.contains(e.target) &&
            !button.contains(e.target)) {
            closeMenu();
        }
    });
})();
