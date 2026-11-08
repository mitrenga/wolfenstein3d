<?php
  require_once 'config/config.php';
  $appName = 'Wolfenstein 3D';
  $appDescription = 'Faithful browser remake of Wolfenstein 3D (id Software / Apogee, DOS 1992) on the svision library: VGA 320x200 in 256 colours, the original data, a ray caster in fixed point.';
  $appPrefix = 'wolf';
  $appNoscript =
    '<h1>'.$appName.'</h1>'.
    '<p>Wolfenstein 3D is the 1992 game by id Software that made the first person shooter what it is: a castle of '.
    'corridors drawn by casting a ray through a grid of tiles, sixty-four by sixty-four. This is a faithful remake of '.
    'the DOS version, running in your web browser. Please enable JavaScript to start the game.</p>';
  require_once 'app/svision/php/main.php';
