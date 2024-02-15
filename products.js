var index = 0;

var imagessrc = ["./gridxpod.png","./gridx-home.png","./gridx-dock.png","./gridx-swapnest.png"];
var img = $("#product-img")[0];
$(".pro-card")[0].value = 0;
$(".pro-card")[1].value = 0;
$(".pro-card")[2].value = 0;
$(".pro-card")[3].value = 1;
$(".pro-card")[4].value = 1;
$(".pro-card")[5].value = 1;
$(".pro-card")[6].value = 2;
$(".pro-card")[7].value = 2;
$(".pro-card")[8].value = 2;
$(".pro-card")[9].value = 3;
$(".pro-card")[10].value =3;
$(".pro-card")[11].value =3;
$(".pro-card").click(
    function(e){
        console.log(e.target);
        img.src=imagessrc[parseInt(e.target.value)]; 
    })