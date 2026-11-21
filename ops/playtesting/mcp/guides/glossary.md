## Glosario de Thoughtseize

- **Partida (match)**. Encuentro completo de un formato de Magic. Comprende uno o más juegos según la configuración. Por ejemplo, una victoria 2–1 al mejor de tres cuenta como una partida y tres juegos.
- **Juego (game)**. Un juego de Magic desde la mano inicial hasta su resultado. Pertenece a una sola partida. El sideboard se usa entre juegos de la misma partida.
- **Jugador Humano (human player)**. Usuario registrado de la aplicación, con su propia biblioteca. Puede permitir que un agente juegue por él en una partida concreta. Cuando activa el modo MCP, el agente toma las decisiones de ese asiento y el usuario puede seguir la mesa y ambas manos en modo espectador desde el navegador. El permiso queda registrado en esa partida.
- **Jugador MCP (MCP player)**. Jugador creado en el motor que se controla exclusivamente mediante MCP. Tiene su propio asiento y biblioteca.
- **Agente (agent)**. Sesión de un modelo de lenguaje que controla a un Jugador MCP o, con el permiso correspondiente, a un Jugador Humano. Cada agente toma decisiones desde la información de su asiento.
- **Oponente (opponent)**. Jugador que se enfrenta a otro en una partida. Puede ser un Jugador Humano o un Jugador MCP. El modo BOT ofrece además un oponente controlado por el motor.
- **Biblioteca (deck library)**. Colección de mazos de un jugador en la aplicación. El Jugador Humano y el Jugador MCP tienen bibliotecas separadas. Durante un juego, las reglas de Magic también llaman «biblioteca» a la zona desde la que ese jugador roba cartas.
- **Historial (match history)**. Registro de las partidas de un jugador y de los juegos de cada partida. El Jugador Humano puede consultarlo en la vista Historial.
- **Espectador (spectator)**. Persona que sigue una partida desde el navegador con acceso de solo lectura. Ve ambas manos, la conversación de los jugadores y los comentarios que los agentes dirigen a la audiencia. El anfitrión puede compartir un enlace para verla sin iniciar sesión.
