var speed = 15;
var distance = 10;
$('#speed button')[0].value = 15;
$('#speed button')[1].value = 25;
$('#speed button')[2].value = 40;
$('#speed h4')[0].value = 15;
$('#speed h4')[1].value = 25;
$('#speed h4')[2].value = 40;
$('#speed p')[0].value = 15;
$('#speed p')[1].value = 25;
$('#speed p')[2].value = 40;

var gridx_cost = $('#gridx-cost')[0];
var local_cost = $('#local-cost')[0];

var speedchange = function (x) {
    speed = parseInt(x.target.value);
    console.log(x.target.value);
    console.log(x.target);
    console.log(speed);
    console.log(distance);
    gridx_cost.innerHTML = Math.floor((30 * speed * distance * 35) / 1000);
    local_cost.innerHTML = Math.floor(((30 * speed * distance * 35) / 1000) * 1.3);
}

var seekchange = function (x) {
    distance = parseInt(x.target.value);
    gridx_cost.innerHTML = Math.floor((30 * speed * distance * 35) / 1000);
    local_cost.innerHTML = Math.floor(((30 * speed * distance * 35) / 1000) * 1.3);
}



$('#seek')[0].onchange = seekchange;
$('button.speed-card').click(speedchange)

