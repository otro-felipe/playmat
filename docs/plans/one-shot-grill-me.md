# Beta privada de playtesting de Magic

Propuesta para la sesión de grill-me. Las decisiones marcadas como recomendadas deben confirmarse antes de convertir esta propuesta en una especificación de implementación.

## Resultado que debe entregar el one-shot

Dos jugadores entran desde equipos distintos con cuentas persistentes y sin flujo de correo. Pueden importar, crear y editar mazos, invitar al otro a un 1v1 por enlace, chatear y volver a abrir un replay terminado después de un redeploy. Un usuario autorizado conecta Codex al MCP privado y usa las mismas cartas, biblioteca e historial. El agente ocupa un asiento propio y juega contra el otro participante. También se puede iniciar una partida contra la IA de XMage.

El código va en GitHub público. La instancia en Railway, las cuentas, los datos de partida, los replays y las llamadas MCP requieren autorización. La beta está enfocada en cruces de mazos e historial, sin ladder.

## La base técnica es la primera decisión

| Criterio | Playmat | XMage Nexus |
|---|---|---|
| Motor | Fork de XMage Java con integración WebSocket propia. La prueba local jugó un 1v1 completo contra un cliente WebMCP. | Cliente React y proxy Java separados de XMage. El proxy habla con versiones concretas de XMage. El build local autocontenido usa una rama de motor de Nexus. Fijar tag del cliente y SHA del motor. |
| UI | Mesa web instalable como PWA, overlays de decisiones, chat de mesa y panel de log. Cambios visuales y de jerarquía son acotados. Reorganizar prompts requiere pruebas por familia. | Mesa y modales más cercanos a la referencia visual solicitada. Ya tiene editor, importación, invitaciones, chat, pantalla completa y manifest standalone. El frontend habla el protocolo de su propio proxy. |
| Biblioteca e historial | Mazos sincronizados por cuenta. Grabador y visor de replays en el servidor, con límites y permisos que hay que ajustar. | El código revisado guarda mazos e historial en el navegador. Board Rewind exporta hasta 40 snapshots por paso. Falta implementar el archivo durable y la sincronización por cuenta. |
| Agentes | WebMCP probado en Chromium. La proyección local cubre decisiones representables como botones y objetos clicables. | MCP stdio ya implementa un cliente de juego sobre el proxy, con espera de prompts y tratamiento de más familias de decisión. Incluye herramientas internas que hay que excluir del MCP del producto. |
| Operación | Base desplegable de Java, web y caché. Documentación de cuentas, SSO, backups y límites. | Web, proxy y servidor XMage separados en su despliegue. Hay que resolver en qué componente vive la identidad del producto y el almacenamiento histórico. |

Revisiones de referencia al 16 de noviembre de 2026. Playmat local `54c8cb26`. La integración de texto de XMage `1.4.63V1` se simuló sin conflictos. Falta compilar y probar el motor combinado. Nexus tiene `v0.8.0` estable y `v0.9.0` en prerelease. Las capacidades de la rama principal de Nexus deben comprobarse en el tag que se elija.

**Recomendación provisional.** Probar Nexus como candidato serio antes de modificar la mesa de Playmat. Si Nexus demuestra un 1v1 con enlace, selección modal, combate, chat y reconexión, y se confirma un punto de captura de la partida ajeno a la pestaña, su UI y su MCP pueden ahorrar más trabajo que adaptar ambos en Playmat. Si el grabador, historial y biblioteca durables entran en la primera entrega y el punto de captura de Nexus queda abierto, Playmat es la base de menor riesgo. Usar un repo y una mesa para la primera entrega.

Prueba discriminante en un checkout aislado de Nexus. Fijar la pareja proxy y XMage, completar un duelo con dos navegadores, reconectar un asiento y confirmar al menos un objetivo y un pago de coste por su MCP. Reproducir ese duelo tras reiniciar el servicio usando una captura en servidor con perspectiva correcta, inicio, final y secuencia. Para Nexus hay que capturar antes de que el proxy compacte snapshots, o evaluar un observador Java dedicado como el de MageBench.

[Playmat](https://github.com/arcanite24/playmat) · [XMage Nexus](https://github.com/Adamychen/xmage-nexus#architecture) · [Releases de Nexus](https://github.com/Adamychen/xmage-nexus/releases) · [MCP de Nexus](https://github.com/Adamychen/xmage-nexus/blob/v0.9.0/mcp/README.md) · [Rewind de Nexus](https://github.com/Adamychen/xmage-nexus/blob/v0.9.0/web/src/game/rewind.ts) · [Mazoteca de Nexus](https://github.com/Adamychen/xmage-nexus/blob/v0.9.0/web/src/decks/storage.ts)

## Cuentas e invitaciones

- Dos cuentas aprovisionadas y registro público cerrado. Confirmar si «sin email» significa sin enviar correos o sin recolectar direcciones. El alta de Playmat con contraseña exige una dirección. Su sign-on con encabezado confiable crea cuentas sin ella y su OIDC vincula por correo verificado. Para cero direcciones, preferir una identidad aprovisionada detrás de un gateway de confianza, con recuperación manual. Si se elige contraseña propia, especificar aprovisionamiento, hash resistente y límites de intentos. El servidor de juego queda en red privada y solo el gateway puede establecer la identidad derivada de una sesión verificada.
- Invitación privada ligada a una mesa y a su asiento, canje explícito después del login, expiración y manejo de doble canje. El link abre la pantalla de elegir mazo. El usuario ve la mesa y el anfitrión inicia el duelo. El enlace por sí solo no autentica la cuenta.
- El MCP remoto usa HTTPS y Streamable HTTP. Un token personal revocable para dos cuentas permite probar antes de elegir OAuth. El gateway mantiene la relación entre cuenta dueña, asiento, visibilidad y permiso. La identidad del agente es distinta de la sesión humana, ya que reutilizar el mismo usuario de motor puede desconectar al navegador. Cada acción verifica permiso vigente y asiento.

[Sign-on en Playmat](https://github.com/arcanite24/playmat/blob/master/docs/TrustedHeaderAuth.md) · [Sesiones de Playmat](https://github.com/arcanite24/playmat/blob/master/docs/WebSocketAPI.md) · [MCP en Codex](https://learn.chatgpt.com/docs/extend/mcp)

## Biblioteca, historial y replays

Una biblioteca por cuenta para UI y MCP. Cada edición aceptada crea una versión inmutable o genera una versión al fijar la lista para jugar. El contrato debe decidir cuándo se crea esa versión. El asiento guarda la que realmente se envió al motor, incluyendo mazo principal y sideboard si corresponde. Separar identidad Oracle, impresión y objeto dentro de una partida. Una escritura con `expected_version` desactualizada falla con la versión vigente, sin pisar ediciones concurrentes. Validar tanto legalidad del formato como disponibilidad en el build del motor.

**DB para consultar, S3 para reproducir.** Guardar en SQL usuarios, mazos y versiones, mesas e invitaciones, encuentros y juegos, participantes, resultado, referencias de artefactos y eventos que alimentan las estadísticas. Para beta, SQLite con un único dueño y volumen persistente es suficiente si se mantiene el backend de Playmat. Si Nexus exige un servicio de producto separado, ese servicio puede ser el dueño de SQLite. Evaluar Postgres si habrá varios escritores o réplicas.

Guardar snapshots y log de partida comprimidos en **S3 privado**. AWS S3 es la recomendación inicial por versionado, lifecycle y recuperación. Un bucket compatible de Railway reduce el número de proveedores si el grill acepta sus diferencias. Mantener independiente el backup SQL. El browser y el MCP consumen páginas filtradas por un servidor autorizado. El archivo crudo de Playmat reúne datos de ambas manos y queda en almacenamiento privado.

Flujo de captura recomendado.

1. Crear encuentro, juego y participantes al arrancar. Capturar desde el servidor o un observador persistente, con secuencia y versión de esquema. Para estadísticas, guardar los eventos tipados con turno y paso en origen, y considerar retrocesos antes de agregarlos.
2. Cerrar el archivo y registrar una subida pendiente. Calcular SHA-256, usar una clave inmutable por juego y artefacto, y registrar el objeto/version y su estado una vez verificada la subida. Los reintentos y la reconciliación tras un reinicio son idempotentes.
3. Autorizar listado y lectura por participante en todas las rutas web y MCP. La vista del replay tiene la información pública y la mano del usuario que lo consulta. Para compartir, diseñar una vista pública optativa si se acepta.
4. Separar estado de juego `activo / terminado / abandonado / interrumpido` de estado de archivo `pendiente / listo / parcial / no disponible`. Conservar la fila si el motor cae. En la primera entrega, persistir y abrir partidas terminadas tras redeploy. La recuperación de una partida en curso requiere un hito propio.

Playmat ya escribe `ndjson.gz` y metadatos de replays. Por defecto purga a 30 días o 300 archivos y limita los registros de un replay, así que hay que establecer retención y estado parcial. Sus RPC actuales de replay se deben cerrar por participante antes de abrir la beta. Nexus tiene caché del proxy para reconexión y export desde el navegador. La UI también llama al replay clásico de XMage. Ese mecanismo usa archivos Java serializados, viene desactivado por defecto y requiere verificar el recorrido web completo. El diseño durable de Nexus sigue dependiendo de una captura y un índice autorizados en servidor.

[Grabador de Playmat](https://github.com/arcanite24/playmat/blob/master/Mage.Server/src/main/java/mage/server/replay/ReplayRecorder.java) · [API de replay](https://github.com/arcanite24/playmat/blob/master/Mage.Server/src/main/java/mage/server/websocket/api/GameApi.java) · [Caché de Nexus](https://github.com/Adamychen/xmage-nexus/blob/v0.9.0/Mage.Proxy/src/main/java/org/mage/proxy/ReplayCache.java) · [Configuración del replay clásico](https://github.com/Adamychen/xmage-nexus/blob/136699b8b45902b69ce56e3f5dd0979d3d7df1ad/Mage.Server/config/config.xml#L24) · [S3 y versionado](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html)

## MCP privado del producto

Borrador de herramientas. Las lecturas van paginadas o agrupadas. Ninguna herramienta de testing, staff o acceso a manos rivales forma parte del contrato.

| Dominio | Herramientas | Condiciones |
|---|---|---|
| Cartas | `search_cards`, `get_cards` | Buscar por nombre y texto Oracle, filtrar por formato y anotar compatibilidad con el motor. Aceptar varios IDs en una consulta. |
| Mazos | `list_decks`, `get_deck`, `create_deck`, `update_deck`, `validate_deck` | La misma biblioteca que la UI. Cambios por versión esperada. Definir si eliminación y exportación se agregan en este corte. |
| Mesas | `list_joinable_games`, `create_game`, `join_game`, `start_game` | Listar solo mesas accesibles. Canjear invitación con versión de mazo. Autorización de anfitrión para iniciar. |
| Jugar | `get_game_state`, `wait_for_decision`, `submit_choice`, `concede_game` | Vista autorizada del asiento. Espera acotada por decisión posterior a un cursor. Envío tipado con decisión vigente y deduplicación. |
| Historial | `list_matches`, `get_match`, `get_replay_page` | Por participante. Cursor y tamaño acotado. Devolver estado parcial o pendiente explícitamente. |
| Chat | `list_chat_messages`, `send_chat_message` | Una mesa autorizada, papel del agente visible, texto plano y fin de acceso al perder el asiento. La escritura depende del permiso del usuario. |

Definir respuestas discriminadas para mulligan y devolver cartas, prioridad, objetivos simples y múltiples, modos y valores de X, orden de disparos, costes y maná, atacantes y bloqueadores, pilas, asignación de cantidades y sideboard si Bo3 entra. El piloto consume IDs y tipos. El contrato no depende del idioma del botón. Cobertura inicial se mide con fixtures de cada familia y una prueba de diálogo desconocido que queda claramente pendiente.

**Plan de turno.** Reutilizar la técnica del prototipo de planificación. Al tener una decisión propia, preparar una línea condicional suponiendo que el rival pasa. Un ejecutor toma el siguiente paso solo si llega el prompt correcto de XMage, sus precondiciones siguen vigentes y es legal. Vuelve a evaluar si el rival responde, aparece un disparo relevante, cambia un objetivo o el paso deja de ser legal. Cada ventana de prioridad se conserva. El piloto usa la información pública, su mano y búsquedas de cartas. El runtime de Codex externo y el botón de IA alojada son alcances distintos para el primer corte.

[MCP de Nexus y familias de decisiones](https://github.com/Adamychen/xmage-nexus/blob/master/mcp/README.md) · [Piloto y captura de MageBench](https://github.com/GregorStocks/mage-bench/blob/master/doc/architecture.md)

## La mesa y el chat

Dos referencias visuales de Nexus a elegir en el grill. Propuesta para el primer corte.

- Campo de batalla más compacto, inspector legible al explorar una carta, indicador estable de quién tiene prioridad o debe decidir, y log/chat en un panel que puede ocultarse.
- Modales para elegir mazo, mulligan, modos, cantidades, seleccionar cartas fuera de la mesa y confirmar concesión. Permitir inspeccionar la mesa cuando la elección lo requiera. Prioridad, seleccionar objetivos visibles, pago de maná y declarar combate quedan junto al tablero.
- Mantener teclado y foco al abrir y cerrar un modal. Escape no pasa prioridad ni cancela una elección obligatoria accidentalmente. Escribir en el chat suspende atajos del juego. Si se agrega botón de pantalla completa, incluir los portales de diálogos. Validar desktop antes de fijar alcance móvil.
- Chat de mesa entre participantes, con log de juego en una pestaña aparte. La retención de mensajes y su aparición en replays quedan por definir. Proteger el canal desde el servidor, además de esconderlo en la UI. Las instrucciones del chat de un jugador se tratan como texto de juego.

[Overlays de Playmat](https://github.com/arcanite24/playmat/blob/master/Mage.Web.Client/src/app/match/Overlays.tsx) · [Chat de Nexus](https://github.com/Adamychen/xmage-nexus/blob/master/web/src/game/GameChat.tsx)

## Railway y pruebas de entrega

- Base fijada por SHA y build del motor por digest. Exponer un solo HTTPS con origen coherente entre app, WebSocket y MCP. Dejar el servidor de juego y su puerto de administración en red privada. El caso local «Sin respuesta» por apuntar al puerto interno se vuelve un escenario de aceptación.
- Consolidar los directorios que el motor necesita conservar bajo un volumen persistente por servicio, fuera de la raíz de la imagen. Usar rutas explícitas, backups consistentes de SQLite y prueba de restore. Probar un redeploy antes de decidir si hace falta subir de plan. Railway deja una pausa al cambiar un deployment ligado al volumen, por lo que se despliega con la mesa vacía durante la beta.
- Bucket privado versionado, permisos mínimos para subida y lectura, reintentos, reconciliación y restauración. Probar primero con fixtures. El entorno de beta usa cuentas, rutas y almacenamiento propios.

BDD antes de implementación. El one-shot es una sola entrega con integración por etapas.

1. **Acceso y mazos.** Dos usuarios aprovisionados entran sin correo. Un tercero no entra ni puede canjear un link ajeno. UI y MCP leen la misma versión de mazo. Dos ediciones concurrentes no se sobrescriben. Crear un mazo, validar formato y fijarlo en una mesa.
2. **Duelo remoto.** Dos navegadores en sesiones distintas abren el mismo link y juegan 1v1. Seleccionan objetivos, pagan un coste, bloquean y reconectan. El chat entrega un mensaje y un tercero queda fuera del canal. Abrir un duelo en pantalla completa con modal visible.
3. **MCP en la misma mesa.** Codex entra por invitación y ocupa asiento propio. Recibe una decisión mientras el rival juega, responde una vez, rechaza ID anterior o de otro asiento y sigue después de un reconnect. Comprueba manos ocultas, familias de prompt acordadas y fin de partida.
4. **Historial durable.** La partida terminada, lista exacta de cada mazo y replay abren tras redeploy. La mano ajena no aparece en endpoints web ni MCP. Una caída de S3 conserva la subida pendiente y su reintento deja un solo artefacto lógico. Una caída del motor queda identificada y un restore recupera índice y replays.
5. **Piloto, si entra al corte.** Una línea preparada avanza si el rival pasa. Una respuesta inesperada la interrumpe. Comparar calidad, tiempo por decisión y costo por partida después de comprobar reglas y privacidad.

[WebSocket de Railway](https://docs.railway.com/networking/public-networking/specs-and-limits) · [Volúmenes](https://docs.railway.com/volumes/reference) · [Backups](https://docs.railway.com/volumes/backups) · [Buckets Railway](https://docs.railway.com/storage-buckets)

## Árbol para el grill-me

No convertir una recomendación de este borrador en un requisito hasta cerrar su rama. En cada ronda abordar solo decisiones cuyas dependencias estén resueltas. Traer los hechos de código y proveedores a la sesión, proponer una respuesta por decisión y registrar las respuestas. El cierre se convierte en especificación, casos de aceptación y prompt de ejecución.

| Decisión | Recomendación inicial | Qué desbloquea |
|---|---|---|
| Base del producto | Comparar la prueba discriminante de Nexus con el duelo ya comprobado en Playmat y elegir un candidato. | UI, puente del motor y mecanismo de captura. |
| Primer corte de juego | Un formato 1v1 acordado, Bo1 y privado. IA del motor y asiento para Codex externo. Decidir si la IA alojada con plan de turno debe entrar ya. | Set de prompts, mazos representativos y definición del one-shot. |
| Qué significa sin email | Cero direcciones y dos cuentas aprovisionadas con recuperación manual. | Proveedor o gateway, emisión de tokens MCP y alta. |
| Qué significa todo el historial | Todo juego terminado, versionado y consultable. Fila y estado para interrumpidos. Replays privados por participante. | Captura, uploader, retención, borrado y posibles enlaces compartidos. |
| Qué chat se entrega | Chat de mesa activo. Guardar el transcript solo si se acuerdan alcance y retención. | Permiso de chat para agentes, historia y visibilidad. |
| Qué apariencia cuenta como lista | Escoger dos o tres escenas de Nexus y acordar desktop primero. | Densidad, inspector, modales y aceptación visual. |
| Política de publicación | Código abierto, beta con invitación. Revisar por separado la publicación de cartas, logos e imágenes. | Distribución pública del servicio y datos. |

La partida real de referencia para probar decisiones incluye respuesta a un artefacto, selección de objetivo, bloqueo durante el turno rival y derrota por daño. Para comparar clientes, agregar al menos un prompt especializado y abrir el replay desde otra sesión.

[Método grill-me](https://github.com/mattpocock/skills/blob/main/docs/productivity/grill-me.md) · [Política de Wizards](https://company.wizards.com/es/legal/fancontentpolicy) · [Pautas de Scryfall](https://scryfall.com/docs/api#use-of-scryfall-data-and-images)
