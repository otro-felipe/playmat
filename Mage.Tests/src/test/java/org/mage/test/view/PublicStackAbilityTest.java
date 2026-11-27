package org.mage.test.view;

import com.google.gson.JsonObject;
import mage.abilities.Ability;
import mage.abilities.keyword.ProwessAbility;
import mage.constants.PhaseStep;
import mage.constants.Zone;
import mage.game.events.TableEvent;
import mage.game.permanent.Permanent;
import mage.game.stack.StackAbility;
import mage.server.websocket.rpc.JsonCodec;
import mage.view.GameView;
import org.junit.Test;
import org.mage.test.serverside.base.CardTestPlayerBase;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

import static org.junit.Assert.*;

public class PublicStackAbilityTest extends CardTestPlayerBase {
    private final List<JsonObject> live = new ArrayList<>();
    private final List<JsonObject> recorded = new ArrayList<>();

    @Test // CUP-AC-006
    public void capturesBothEmberheartChallengerTriggersAboveRecklessRage() {
        String challenger = "Emberheart Challenger";
        addCard(Zone.BATTLEFIELD, playerA, challenger);
        addCard(Zone.BATTLEFIELD, playerA, "Mountain");
        addCard(Zone.BATTLEFIELD, playerB, "Grizzly Bears");
        addCard(Zone.HAND, playerA, "Reckless Rage");
        addCard(Zone.LIBRARY, playerA, "Mountain", 4);
        observeStack();
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Reckless Rage", "Grizzly Bears^" + challenger);
        setStopAt(1, PhaseStep.BEGIN_COMBAT);
        execute();

        for (List<JsonObject> frames : Arrays.asList(live, recorded)) {
            List<JsonObject> stack = frames.stream().map(PublicStackAbilityTest::entries)
                    .filter(cards -> cards.size() == 3 && cards.get(2).get("name").getAsString().equals("Reckless Rage"))
                    .findFirst().orElseThrow(() -> new AssertionError("Both triggers are absent above Reckless Rage: " + observed(frames)));
            List<String> rules = new ArrayList<>();
            String sourceId = null;
            for (JsonObject item : stack.subList(0, 2)) {
                JsonObject ability = item.getAsJsonObject("stackAbility");
                assertNotNull(ability);
                assertEquals("triggered", ability.get("kind").getAsString());
                JsonObject source = ability.getAsJsonObject("source");
                assertEquals(challenger, source.get("name").getAsString());
                assertEquals("card", source.get("kind").getAsString());
                if (sourceId == null) sourceId = source.get("id").getAsString();
                assertEquals(sourceId, source.get("id").getAsString());
                rules.add(ability.get("effect").getAsString());
            }
            assertTrue(rules.stream().anyMatch(rule -> rule.contains("+1/+1 until end of turn")));
            assertTrue(rules.stream().anyMatch(rule -> rule.toLowerCase(Locale.ROOT).contains("exile the top card of your library")));
            assertNotEquals(stack.get(0).get("id"), stack.get(1).get("id"));
        }
    }

    @Test // CUP-AC-006
    public void capturesFoodAfterTheTokenWasSacrificedToActivateIt() {
        addCard(Zone.BATTLEFIELD, playerA, "Forest", 3);
        addCard(Zone.HAND, playerA, "Gilded Goose");
        observeStack();
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Gilded Goose");
        activateAbility(1, PhaseStep.POSTCOMBAT_MAIN, playerA, "{2}, {T}, Sacrifice");
        setStopAt(1, PhaseStep.END_TURN);
        execute();
        assertLife(playerA, 23);

        for (List<JsonObject> frames : Arrays.asList(live, recorded)) {
            Optional<JsonObject> food = frames.stream().flatMap(frame -> entries(frame).stream())
                    .filter(card -> card.has("stackAbility")).map(card -> card.getAsJsonObject("stackAbility"))
                    .filter(ability -> ability.get("kind").getAsString().equals("activated"))
                    .filter(ability -> ability.has("source"))
                    .filter(ability -> !ability.getAsJsonObject("source").has("id"))
                    .findFirst();
            JsonObject ability = food.orElseThrow(() -> new AssertionError("The sacrificed token is missing from its stack ability: " + observed(frames)));
            JsonObject source = ability.getAsJsonObject("source");
            assertEquals("Food Token", source.get("name").getAsString());
            assertEquals("token", source.get("kind").getAsString());
            assertTrue(ability.get("effect").getAsString().contains("You gain 3 life"));
        }
    }

    @Test // CUP-AC-006
    public void aLaterFaceUpIncarnationCannotExposeAnOlderConcealedSource() {
        String challenger = "Emberheart Challenger";
        addCard(Zone.BATTLEFIELD, playerA, challenger);
        runCode("capture a pending ability with exact and newer battlefield history", 1, PhaseStep.PRECOMBAT_MAIN, playerA, (info, player, game) -> {
            Permanent source = game.getBattlefield().getAllPermanents().stream().filter(card -> challenger.equals(card.getName())).findFirst().get();
            Ability declaration = source.getAbilities().stream().filter(ProwessAbility.class::isInstance).findFirst().get();
            StackAbility pending = new StackAbility(declaration.copy(), playerA.getId());
            pending.newId();
            int priorIncarnation = source.getZoneChangeCounter(game);
            pending.setSourceObjectZoneChangeCounter(priorIncarnation);
            source.setFaceDown(true, game);
            game.rememberLKI(Zone.BATTLEFIELD, source);
            game.getStack().push(pending);
            assertHidden(entries(stack(GameView.forReplay(game, null, null))).get(0));

            source.setFaceDown(false, game);
            source.updateZoneChangeCounter(game, null);
            game.rememberLKI(Zone.BATTLEFIELD, source);
            pending.setSourceObjectZoneChangeCounter(0);
            assertHidden(entries(stack(GameView.forReplay(game, null, null))).get(0));
            pending.setSourceObjectZoneChangeCounter(priorIncarnation);
            game.getBattlefield().removePermanent(source.getId());
            game.getState().setZone(source.getId(), Zone.HAND);
            assertHidden(entries(stack(GameView.forReplay(game, null, null))).get(0));
            game.getStack().pop();
        });
        setStopAt(1, PhaseStep.BEGIN_COMBAT);
        execute();
    }

    private static void assertHidden(JsonObject stackCard) {
        JsonObject ability = stackCard.getAsJsonObject("stackAbility");
        assertEquals("triggered", ability.get("kind").getAsString());
        assertFalse(ability.has("source"));
        assertFalse(ability.has("effect"));
    }

    private void observeStack() {
        runCode("capture spectator and replay stack frames", 1, PhaseStep.PRECOMBAT_MAIN, playerA, (info, player, game) -> {
            game.addTableEventListener(event -> {
                if ((event.getEventType() == TableEvent.EventType.INFO || event.getEventType() == TableEvent.EventType.UPDATE)
                        && !game.getStack().isEmpty()) {
                    live.add(stack(new GameView(game.getState(), game, null, null)));
                    recorded.add(stack(GameView.forReplay(game, null, null)));
                }
            });
        });
    }

    private static List<List<String>> observed(List<JsonObject> frames) {
        return frames.stream().map(PublicStackAbilityTest::entries)
                .map(cards -> cards.stream().map(card -> card.get("name") + " " + card.get("stackAbility"))
                        .collect(Collectors.toList())).collect(Collectors.toList());
    }

    private static JsonObject stack(GameView view) {
        return JsonCodec.GSON.toJsonTree(view).getAsJsonObject().getAsJsonObject("stack");
    }

    private static List<JsonObject> entries(JsonObject stack) {
        return stack.entrySet().stream().map(Map.Entry::getValue).map(row -> row.getAsJsonObject()).collect(Collectors.toList());
    }
}
