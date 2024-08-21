var speed = 25;
var distance = 65;
$('#speed button')[0].value = 15;
$('#speed button')[1].value = 20;
$('#speed button')[2].value = 30;
$('#speed h4')[0].value = 15;
$('#speed h4')[1].value = 20;
$('#speed h4')[2].value = 30;
$('#speed p')[0].value = 15;
$('#speed p')[1].value = 20;
$('#speed p')[2].value = 30;

var gridx_cost = $('#gridx-cost')[0];
var local_cost = $('#local-cost')[0];

var speedchange = function (x) {
    speed = parseInt(x.target.value);
    var max = 7920;
    var gridbar = Math.floor((30 * speed * distance * 35) / 1000);
    var IECbar = Math.floor((2.2 * distance * 30));

    gridx_cost.innerHTML = gridbar;
    local_cost.innerHTML = IECbar;
    console.log("x");


    $('#saving')[0].innerHTML = 100 - Math.floor((gridbar * 100) / IECbar);
    $('#distance')[0].innerHTML = distance;
    $("#gridbar").height($("#gridbar").parent().height() * (gridbar / max));
    $("#IECbar").height($("#gridbar").parent().height() * (IECbar / max));
}

var seekchange = function (x) {
    distance = parseInt(x.target.value);

    var max = 7920;
    var gridbar = Math.floor((30 * speed * distance * 35) / 1000);
    var IECbar = Math.floor((2.2 * distance * 30));

    gridx_cost.innerHTML = gridbar;
    local_cost.innerHTML = IECbar;
    console.log("x");

    $("#gridbar").height($("#gridbar").parent().height() * (gridbar / max));
    $("#IECbar").height($("#gridbar").parent().height() * (IECbar / max));
    $('#saving')[0].innerHTML = 100 - Math.floor((gridbar * 100) / IECbar);
    $('#distance')[0].innerHTML = distance;

}

var gridxbarfrac =
    $(document).ready(function () {
        var max = 7920;
        var gridbar = Math.floor((30 * speed * distance * 35) / 1000);
        var IECbar = Math.floor((2.2 * distance * 30));

        gridx_cost.innerHTML = gridbar;
        local_cost.innerHTML = IECbar;

        $("#gridbar").height($("#gridbar").parent().height() * (gridbar / max));
        $("#IECbar").height($("#gridbar").parent().height() * (IECbar / max));
        $('#saving')[0].innerHTML = 100 - Math.floor((gridbar * 100) / IECbar);
        $('#distance')[0].innerHTML = distance;

    });


$('#seek')[0].onchange = seekchange;
$('button.speed-card').click(speedchange);

