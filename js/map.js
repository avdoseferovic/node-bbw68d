/*
 * map.js - loads/handles eo map files
 */

'use strict';

let config = require('./config.js');
let fs = require('fs');
let packet = require('./packet.js');
let utils = require('./utils.js');
let structs = require('./structs.js');
let npc = require('./npc.js');

function mapItem(uid, id, amount, x, y, owner, unProtectTime) {
	return {
		uid: uid,
		id: id,
		amount: amount,
		x: x,
		y: y,
		owner: owner,
		unProtectTime: unProtectTime
	}
}

function mapWarp(map, x, y, levelReq, spec) {
	return {
		map: map,
		x: x,
		y: y,
		levelReq: levelReq,
		spec: spec,
		open: false
	}
}

function mapChest(x, y) {
	return {
		x: x,
		y: y,
		
		items: [],
		spawns: [],
		slots: 0,
		
		hasItem: function (id) {
			for (var i = 0; i < this.items.length; i++) {
				var item = this.items[i];
				if (item.id === id) {
					return item.amount;
				}
			}
			
			return 0;
		},
		
		addItem: function (id, amount, slot) {
			var $this = this;
			
			if (amount <= 0) {
				return 0;
			}
			
			if (!slot) {
				for (var i = 0; i < $this.items.length; i++) {
					var item = $this.items[i];
					if (item.id === id) {
						if (item.amount + amount < 0 || item.amount + amount > config.MaxChests) {
							return 0;
						}
						
						$this.items[i].amount += amount;
						return amount;
					}
				}
			}
			
			if ($this.items.length >= config.ChestSlots || amount > config.MaxChests) {
				return 0;
			}
			
			if (!slot) {
				var userItems = 0;
				
				for (var i = 0; i < $this.items.length; i++) {
					var item = $this.items[i];
					if (item.slot === 0) {
						++userItems;
					}
					
					if (userItems + $this.slots >= config.ChestSlots) {
						return 0;
					}
				}
			}
			
			var chestItem = {
				id: id,
				amount: amount,
				slot: slot || 0
			};
			
			if (!slot) {
				$this.items.push(chestItem);
			} else {
				$this.items.unshift(chestItem);
			}
			
			return amount;
		},
		
		delItem: function (id) {
			var $this = this;
			for (var i = 0; i < $this.items.length; i++) {
				var item = $this.items[i];
				if (item.id === id) {
					var amount = item.amount;
					
					if (item.slot) {
						var now = new Date;
						
						utils.forEach($this.spawns, function (spawn, ii) {
							if (spawn.slot === item.slot) {
								$this.spawns[ii].last_taken = now;
							}
						});
					}
					
					$this.items.splice(i, 1);
					return amount;
				}
			}
		},
		delSomeItem: function (id, amount) {
			var $this = this;
			for (var i = 0; i < $this.items.length; i++) {
				var item = $this.items[i];
				if (item.id === id) {
					if (amount < item.amount) {
						$this.items[i].amount -= amount;
						
						if (item.slot) {
							var now = new Date;
							
							utils.forEach($this.spawns, function (spawn, ii) {
								if (spawn.slot === item.slot) {
									$this.spawns[ii].last_taken = now;
								}
							});
							
							$this.items[i].slot = 0;
						}
						
						return $this.item[i].amount;
					} else {
						return $this.delItem(id);
					}
				}
			}
			
			return 0;
		},
		update: function (map, exclude) {
			var $this = this;
			var builder = packet.builder(packet.family.CHEST, packet.action.AGREE);
			
			utils.forEach(this.items, function (item) {
				builder.addShort(item.id);
				builder.addThree(item.amount);
			});
			
			utils.forEach(map.characters, function (char) {
				if (char !== exclude && utils.pathLength(char.x, char.y, $this.x, $this.y) <= 1) {
					char.send(builder);
				}
			});
		}
	}
}

function spawnChests(map) {
	var now = new Date;
	
	utils.forEach(map.chests, function (chest, i) {
		var needsUpdate = false;
		
		var spawns = [];
		
		utils.forEach(chest.spawns, function (spawn) {
			var nextSpawnTime = new Date(spawn.last_taken);
			nextSpawnTime.setMinutes(nextSpawnTime.getMinutes() + spawn.time);
			
			if (nextSpawnTime <= now) {
				var slot_used = false;
				
				utils.forEach(chest.items, function (item) {
					if (item.slot === spawn.slot) {
						slot_used = true;
					}
				});
				
				if (!slot_used) {
					if (typeof spawns[spawn.slot - 1] !== 'undefined') {
						spawns[spawn.slot - 1].push(spawn);
					} else {
						spawns[spawn.slot - 1] = [spawn];
					}
				}
			}
		});
		
		utils.forEach(spawns, function (slot_spawns) {
			if (slot_spawns && slot_spawns.length > 0) {
				var spawn = slot_spawns[utils.random(0, slot_spawns.length - 1)];
				map.chests[i].addItem(spawn.item.id, spawn.item.amount, spawn.slot);
				needsUpdate = true;
			}
		});
		
		if (needsUpdate) {
			map.chests[i].update(map);
		}
	});
}

function mapCloseDoor(map, x, y) {
	map.closeDoor(x, y);
}

function Map(id, world) {
	var map = {
		id: id,
		world: world,
		exists: false,
		jukebox_protect: 0.0,
		jukebox_player: '',
		arena: 0,
		evacuate_lock: false,
		has_timed_spikes: false,
		characters: [],
		npcs: [],
		chests: [],
		items: [],
		tiles: [],
		rid: [],
		pk: false,
		effect: 0,
		width: 0,
		height: 0,
		scroll: 0,
		relogX: 0,
		relogY: 0,
		filesize: 0,
		delItem: function (item, character) {
			let itemIndex = this.items.indexOf(this.items.filter(function (_item) {
				return _item.uid === item.uid;
			})[0]);

			if (itemIndex > -1) {
				let builder = packet.builder(packet.family.ITEM, packet.action.REMOVE);
				builder.addShort(item.uid);

				utils.forEach(this.characters, function (char) {
					if (char !== character && char.inRange(item.x, item.y)) {
						char.send(builder);
					}
				});
				
				this.items.splice(itemIndex, 1);
			}
		},
		delSomeItem: function (uid, amount, character) {
			if (amount < 0) {
				return;
			}

			let item = this.items.filter(function (item) {
				return item.uid === uid;
			})[0];

			if (item) {
				if (amount < item.amount) {
					item.amount -= amount;
					this.updateItem(item);

					let builder = packet.builder(packet.family.ITEM, packet.action.REMOVE);
					builder.addShort(item.uid);

					utils.forEach(this.characters, function (char) {
						if (char !== character && char.inRange(item.x, item.y)) {
							char.send(builder);
						}
					});

					builder = packet.builder(packet.family.ITEM, packet.action.ADD);
					builder.addShort(item.id);
					builder.addShort(item.uid);
					builder.addThree(item.amount);
					builder.addChar(item.x);
					builder.addChar(item.y);

					utils.forEach(this.characters, function (char) {
						if (char.inRange(item.x, item.y)) {
							char.send(builder);
						}
					});
				} else {
					this.delItem(item, character);
				}
			}
		},
		generateItemID: function () {
			let $this = this;
			let lowestFreeID = 1;
			
			(function findNextID() {
				utils.forEach($this.items, function (item) {
					if (item.uid === lowestFreeID) {
						lowestFreeID = item.uid + 1;
						findNextID();
					}
				});
			})();
			
			return lowestFreeID;
		},
		getItem: function (id) {
			return this.items[this.items.indexOf(this.items.filter(function (item) {
				return item.uid === id;
			})[0])];
		},
		updateItem: function (item) {
			let itemIndex = this.items.indexOf(this.items.filter(function (_item) {
				return _item.uid === item.uid;
			}));
			
			if (itemIndex > -1) {
				this.items[itemIndex] = item;
			}
		},
		addItem: function (id, amount, x, y, character) {
			let newItem = mapItem(0, id, amount, x, y, null, null);
			
			if (character) {
				let onTile = 0;
				let onMap = this.items.length;
				
				let itemsOnTile = this.tiles.filter(function (item) {
					return item.x === x && item.y === y;
				});
				
				if (itemsOnTile && itemsOnTile.length) {
					onTile = itemsOnTile.length;
				}
				
				if (onTile >= config.MaxTile || onMap >= config.MaxMap) {
					return newItem;
				}
			}
			
			newItem.uid = this.generateItemID();
			
			let builder = packet.builder(packet.family.ITEM, packet.action.ADD);
			builder.addShort(id);
			builder.addShort(newItem.uid);
			builder.addThree(amount);
			builder.addChar(x);
			builder.addChar(y);
			
			utils.forEach(this.characters, function (char) {
				if (char !== character && char.inRange(x, y)) {
					char.send(builder);
				}
			});

			this.items.push(newItem);

			return newItem;
		},
		closeDoor: function (x, y) {
			if (!this.inBounds(x, y)) {
				return;
			}

			let tile = this.getTile(x, y);
			if (tile.warp) {
				if (tile.warp.spec === structs.warpSpec.NoDoor || !tile.warp.open) {
					return;
				}

				tile.warp.open = false;
				this.setTile(x, y, tile);	
			}
		},
		openDoor: function (character, x, y) {
			if (!this.inBounds(x, y) || (character && !character.inRange(x, y))) { 
				return false;
			}

			let tile = this.getTile(x, y);
			if (tile.warp) {
				if (tile.warp.spec === structs.warpSpec.NoDoor || tile.warp.open) {
					return false;
				}
				
				// NOTE: check if player has key
				if (character && tile.warp.spec > structs.warpSpec.Door) {
					if (!character.hasItem(this.world.eif.getKey(tile.warp.spec - structs.warpSpec.Door + 1))) {
						return false;
					}
				}

				let builder = packet.builder(packet.family.DOOR, packet.action.OPEN);
				builder.addChar(x);
				builder.addShort(y);

				utils.forEach(this.characters, function (char) {
					if (char.inRange(x, y)) {
						char.send(builder);	
					}
				});

				tile.warp.open = true;
				this.setTile(x, y, tile);
				
				setTimeout(function () {
					mapCloseDoor(map, x, y);
				}, config.DoorTimer);

				return true;
			}

			return false;
		},
		getCharacter: function (name) {
			return this.characters.filter(function (char) {
				return char.name === name;
			})[0];
		},
		getCharacterPID: function (id) {
			return this.characters.filter(function (char) {
				return char.playerID() === id;
			})[0];
		},
		getCharacterCID: function (id) {
			return this.characters.filter(function (char) {
				return char.id === id;
			})[0];
		},
		inBounds: function (x, y) {
			return !(x >= this.width || y >= this.height);
		},
		walkable: function (x, y, npc) {
			if (!this.inBounds(x, y) || !this.getTile(x, y).walkable(npc)) {
				return false;
			}
			
			return true;
		},
		enter: function (character, animation) {
			this.characters.push(character);
			character.map = this;
			character.attacks = 0;
			
			var builder = packet.builder(packet.family.PLAYERS, packet.action.AGREE);
			builder.addByte(255);
			builder.addBreakString(character.name);
			builder.addShort(character.playerID());
			builder.addShort(character.mapid);
			builder.addShort(character.x);
			builder.addShort(character.y);
			builder.addChar(character.direction);
			builder.addChar(6); // ?
			builder.addString(character.paddedGuildTag());
			builder.addChar(character.level);
			builder.addChar(character.gender);
			builder.addChar(character.hairStyle);
			builder.addChar(character.hairColor);
			builder.addChar(character.race);
			builder.addShort(character.max_hp);
			builder.addShort(character.hp);
			builder.addShort(character.max_tp);
			builder.addShort(character.tp);
			character.addPaperdollData(builder, 'B000A0HSW');
			builder.addChar(character.sitting);
			builder.addChar(character.hidden);
			builder.addChar(animation);
			builder.addByte(255);
			builder.addChar(1); // 0 = NPC, 1 = player
			
			utils.forEach(this.characters, function (_char) {
				if (_char !== character && character.charInRange(_char)) {
					_char.send(builder);
				}
			});
		},
		leave: function (character, animation, silent) {
			if (!silent) {
				var builder = packet.builder(packet.family.AVATAR, packet.action.REMOVE);
				builder.addShort(character.playerID());
				
				if (animation !== structs.warpAnimation.none) {
					builder.addChar(animation);
				}
				
				utils.forEach(this.characters, function (char) {
					if (char !== character && character.charInRange(char)) {
						char.send(builder);
					}
				});
			}
			
			this.characters.splice(this.characters.indexOf(this.characters.filter(function (char) {
				return char.id === character.id;
			})[0]), 1);
			
			character.map = null;
		},
		msg: function (character, message, echo) {
			var builder = packet.builder(packet.family.TALK, packet.action.PLAYER);
			builder.addShort(character.playerID());
			builder.addString(message);
			
			utils.forEach(this.characters, function (char) {
				if (char !== character && character.charInRange(char)) {
					char.send(builder);
				}
			});
		},
		attack: function (character, direction) {
			character.direction = direction;
			character.attacks++;
			character.cancelSpell();
			
			// TODO: arena
			
			// TODO: instrument / pk
			
			var builder = packet.builder(packet.family.ATTACK, packet.action.PLAYER);
			builder.addShort(character.playerID());
			builder.addChar(direction);
			
			utils.forEach(this.characters, function (char) {
				if (char !== character && character.charInRange(char)) {
					char.send(builder);
				}
			});
            
            // TODO: actually damage shit
		},
		sit: function (character, state) {
			character.sitting = state;
			character.cancelSpell();
			
			var builder = packet.builder(state === structs.sitState.chair ? packet.family.CHAIR : packet.family.SIT, packet.action.PLAYER);
			builder.addShort(character.playerID());
			builder.addChar(character.x);
			builder.addChar(character.y);
			builder.addChar(character.direction);
			builder.addChar(0);
			
			utils.forEach(this.characters, function (char) {
				if (char !== character && character.charInRange(char)) {
					char.send(builder);
				}
			});
		},
		stand: function (character) {
			character.sitting = structs.sitState.stand;
			character.cancelSpell();
			
			var builder = packet.builder(packet.family.SIT, packet.action.REMOVE);
			builder.addShort(character.playerID());
			builder.addChar(character.x);
			builder.addChar(character.y);
			
			utils.forEach(this.characters, function (char) {
				if (char !== character && character.charInRange(char)) {
					char.send(builder);
				}
			});
		},
		emote: function (character, emote, echo) {
			var builder = packet.builder(packet.family.EMOTE, packet.action.PLAYER);
			builder.addShort(character.playerID());
			builder.addChar(emote);
			
			utils.forEach(this.characters, function (char) {
				if (echo || char !== character && character.charInRange(char)) {
					char.send(builder);
				}
			});
		},
		face: function (character, direction) {
			character.direction = direction;
			character.cancelSpell();
			
			var builder = packet.builder(packet.family.FACE, packet.action.PLAYER);
			builder.addShort(character.playerID());
			builder.addChar(direction);
			
			utils.forEach(this.characters, function (char) {
				if (char !== character && character.charInRange(char)) {
					char.send(builder);
				}
			});
		},
		walk: function (character, direction, admin) {
			var seeDistance = 11;
			var targetX = character.x;
			var targetY = character.y;
			
			switch (direction) {
				case structs.direction.UP:
					targetY -= 1;
					
					if (targetY > character.y) {
						return;
					}
					break;
				case structs.direction.RIGHT:
					targetX += 1;
					
					if (targetX < character.x) {
						return;
					}
					break;
				case structs.direction.DOWN:
					targetY += 1;
					
					if (targetY < character.y) {
						return;
					}
					break;
				case structs.direction.LEFT:
					targetX -= 1;
					
					if (targetX > character.x) {
						return;
					}
					break;
			}
			
			if (!this.inBounds(targetX, targetY)) {
				return structs.walkResult.fail;
			}
			
			if (!admin) {
				if (!this.walkable(targetX, targetY)) {
					return structs.walkResult.fail;
				}
                
                // if (this.occupied) TODO: ghosts
			}
			
			var warp = this.getTile(targetX, targetY).warp;
			
			if (warp) {
				if (character.level >= warp.levelReq && (warp.spec === structs.warpSpec.NoDoor || warp.open)) {
					character.warp(warp.map, warp.x, warp.y);
					return structs.walkResult.warped;
				}
			}
			
			character.last_walk = new Date;
			character.attacks = 0;
			character.cancelSpell();
			character.direction = direction;
			character.x = targetX;
			character.y = targetY;
			
			var newx;
			var newy;
			var oldx;
			var oldy;
			
			var newCoords = [];
			var oldCoords = [];
			
			var newChars = [];
			var oldChars = [];
			var newNPCs = [];
			var oldNPCs = [];
			var newItems = [];
			
			switch (direction) {
				case structs.direction.UP:
					for (var i = -seeDistance; i < seeDistance; i++) {
						newy = character.y - seeDistance + Math.abs(i);
						newx = character.x + i;
						oldy = character.y + seeDistance + 1 - Math.abs(i);
						oldx = character.x + i;
						
						newCoords.push({
							x: newx,
							y: newy
						});
						
						oldCoords.push({
							x: oldx,
							y: oldy
						});
					}
					break;
				case structs.direction.RIGHT:
					for (var i = -seeDistance; i < seeDistance; i++) {
						newy = character.y + i;
						newx = character.x + seeDistance - Math.abs(i);
						oldy = character.y + i;
						oldx = character.x - seeDistance - 1 + Math.abs(i);
						
						newCoords.push({
							x: newx,
							y: newy
						});
						
						oldCoords.push({
							x: oldx,
							y: oldy
						});
					}
					break;
				case structs.direction.DOWN:
					for (var i = -seeDistance; i < seeDistance; i++) {
						newy = character.y + seeDistance - Math.abs(i);
						newx = character.x + i;
						oldy = character.y - seeDistance - 1 + Math.abs(i);
						oldx = character.x + i;
						
						newCoords.push({
							x: newx,
							y: newy
						});
						
						oldCoords.push({
							x: oldx,
							y: oldy
						});
					}
					break;
				case structs.direction.LEFT:
					for (var i = -seeDistance; i < seeDistance; i++) {
						newy = character.y + i;
						newx = character.x - seeDistance + Math.abs(i);
						oldy = character.y + i;
						oldx = character.x + seeDistance + 1 - Math.abs(i);
						
						newCoords.push({
							x: newx,
							y: newy
						});
						
						oldCoords.push({
							x: oldx,
							y: oldy
						});
					}
					break;
			}
			
			utils.forEach(this.characters, function (char) {
				if (char !== character) {
					for (var i = 0; i < oldCoords.length; i++) {
						if (char.x === oldCoords[i].x && char.y === oldCoords[i].y) {
							oldChars.push(char);
						} else if (char.x === newCoords[i].x && char.y === newCoords[i].y) {
							newChars.push(char);
						}
					}
				}
			});
			
			utils.forEach(this.npcs, function (npc) {
			    if (npc.alive) {
			        for (let i = 0; i < oldCoords.length; i++) {
			            if (npc.x === oldCoords[i].x && npc.y === oldCoords[i].y) {
			                oldNPCs.push(npc);
			            } else if (npc.x === newCoords[i].x && npc.y === newCoords[i].y) {
			                newNPCs.push(npc);
			            }
			        }
			    }
			});
			
			utils.forEach(this.items, function (item) {
				if (character.inRange(item.x, item.y)) {
					newItems.push(item);
				}
			});
			
			var builder = packet.builder(packet.family.AVATAR, packet.action.REMOVE);
			builder.addShort(character.playerID());
			
			utils.forEach(oldChars, function (char) {
				var rBuilder = packet.builder(packet.family.AVATAR, packet.action.REMOVE);
				rBuilder.addShort(char.playerID());
				
				char.send(builder);
				character.send(rBuilder);
			});
			
			builder = packet.builder(packet.family.PLAYERS, packet.action.AGREE);
			builder.addByte(255);
			builder.addBreakString(character.name);
			builder.addShort(character.playerID());
			builder.addShort(character.mapid);
			builder.addShort(character.x);
			builder.addShort(character.y);
			builder.addChar(character.direction);
			builder.addChar(6); // ?
			builder.addString(character.paddedGuildTag());
			builder.addChar(character.level);
			builder.addChar(character.gender);
			builder.addChar(character.hairStyle);
			builder.addChar(character.hairColor);
			builder.addChar(character.race);
			builder.addShort(character.max_hp);
			builder.addShort(character.hp);
			builder.addShort(character.max_tp);
			builder.addShort(character.tp);
			character.addPaperdollData(builder, 'B000A0HSW');
			builder.addChar(character.sitting);
			builder.addChar(character.hidden);
			builder.addByte(255);
			builder.addChar(1); // 0 = NPC, 1 = player
			
			utils.forEach(newChars, function (char) {
				var rBuilder = packet.builder(packet.family.PLAYERS, packet.action.AGREE);
				rBuilder.addByte(255);
				rBuilder.addBreakString(char.name);
				rBuilder.addShort(char.playerID());
				rBuilder.addShort(char.mapid);
				rBuilder.addShort(char.x);
				rBuilder.addShort(char.y);
				rBuilder.addChar(char.direction);
				rBuilder.addChar(6); // ?
				rBuilder.addString(char.paddedGuildTag());
				rBuilder.addChar(char.level);
				rBuilder.addChar(char.gender);
				rBuilder.addChar(char.hairStyle);
				rBuilder.addChar(char.hairColor);
				rBuilder.addChar(char.race);
				rBuilder.addShort(char.max_hp);
				rBuilder.addShort(char.hp);
				rBuilder.addShort(char.max_tp);
				rBuilder.addShort(char.tp);
				char.addPaperdollData(rBuilder, 'B000A0HSW');
				rBuilder.addChar(char.sitting);
				rBuilder.addChar(char.hidden);
				rBuilder.addByte(255);
				rBuilder.addChar(1); // 0 = NPC, 1 = player
				
				char.send(builder);
				character.send(rBuilder);
			});
			
			builder = packet.builder(packet.family.WALK, packet.action.PLAYER);
			builder.addShort(character.playerID());
			builder.addChar(direction);
			builder.addChar(character.x);
			builder.addChar(character.y);
			
			utils.forEach(this.characters, function (char) {
				if (char !== character && character.charInRange(char)) {
					char.send(builder);
				}
			});
			
			builder = packet.builder(packet.family.WALK, packet.action.REPLY);
			builder.addByte(255);
			builder.addByte(255);
			
			utils.forEach(newItems, function (item) {
				builder.addShort(item.uid);
				builder.addShort(item.id);
				builder.addChar(item.x);
				builder.addChar(item.y);
				builder.addThree(item.amount);
			});
			
			character.send(builder);
			
			utils.forEach(newNPCs, function (npc) {
			    builder = packet.builder(packet.family.APPEAR, packet.action.REPLY);
			    builder.addChar(0);
			    builder.addByte(255);
			    builder.addChar(npc.index);
			    builder.addShort(npc.id);
			    builder.addChar(npc.x);
			    builder.addChar(npc.y);
			    builder.addChar(npc.direction);

			    character.send(builder);
			});
			
			utils.forEach(oldNPCs, function (npc) {
			    npc.removeFromView(character);
			});
			
			// TODO: check quests rules
			
			// TODO: spike damage
			
			return structs.walkResult.ok;
		},
		getTile: function (x, y) {
			return this.tiles[y * this.width + x];
		},
		setTile: function (x, y, tile) {
			this.tiles[y * this.width + x] = tile;
		},
		load: function () {
			var fileName = '';
			
			function readBuf(buf, length) {
				var ret = buf.slice(buf.curPos, buf.curPos + length);
				buf.curPos += length;
				return ret;
			}
			
			for (var i = 0; i < 5 - this.id.toString().length; i++) {
				fileName += '0';
			}
			
			fileName += this.id + '.emf';
			
			var stats;
			try {
				stats = fs.statSync(config.MapDir + '/' + fileName);
				if (stats) {
					var fData = packet.bufferToStr(fs.readFileSync(config.MapDir + '/' + fileName)).split('');
					fData.curPos = 0x03;
					
					this.rid = readBuf(fData, 4);
					for (var i = 0; i < this.rid.length; i++) {
						this.rid[i] = this.rid[i].charCodeAt();
					}
					
					var buf;
					var outersize;
					var innersize;
					
					fData.curPos = 0x1F;
					buf = readBuf(fData, 2);
					this.pk = packet.packEOInt(buf[0].charCodeAt()) === 3;
					this.effect = packet.packEOInt(buf[1].charCodeAt());
					
					fData.curPos = 0x25;
					buf = readBuf(fData, 2);
					this.width = packet.packEOInt(buf[0].charCodeAt()) + 1;
					this.height = packet.packEOInt(buf[1].charCodeAt()) + 1;
					
					for (var i = 0; i < this.width * this.height; i++) {
						this.tiles.push({
							tilespec: -1,
							warp: null,
							walkable: function (npc) {
								switch (this.tilespec) {
									case structs.tileSpec.wall:
									case structs.tileSpec.chairDown:
									case structs.tileSpec.chairLeft:
									case structs.tileSpec.chairRight:
									case structs.tileSpec.chairUp:
									case structs.tileSpec.chairDownRight:
									case structs.tileSpec.chairUpLeft:
									case structs.tileSpec.chairAll:
									case structs.tileSpec.chest:
									case structs.tileSpec.bankVault:
									case structs.tileSpec.mapEdge:
									case structs.tileSpec.board1:
									case structs.tileSpec.board2:
									case structs.tileSpec.board3:
									case structs.tileSpec.board4:
									case structs.tileSpec.board5:
									case structs.tileSpec.board6:
									case structs.tileSpec.board7:
									case structs.tileSpec.board8:
									case structs.tileSpec.jukebox:
										return false;
									case structs.tileSpec.npcBoundary:
										return !npc;
									default:
										return true;
								}
							}
						});
					}
					
					fData.curPos = 0x2A;
					buf = readBuf(fData, 3);
					this.scroll = packet.packEOInt(buf[0].charCodeAt());
					this.relogX = packet.packEOInt(buf[1].charCodeAt());
					this.relogY = packet.packEOInt(buf[2].charCodeAt());
					
					fData.curPos = 0x2E;
					buf = readBuf(fData, 1);
					outersize = packet.packEOInt(buf[0].charCodeAt());
					if (outersize) {
						fData.curPos += 8 * outersize;
					}
					
					buf = readBuf(fData, 1);
					outersize = packet.packEOInt(buf[0].charCodeAt());
					if (outersize) {
						fData.curPos += 4 * outersize;
					}
					
					buf = readBuf(fData, 1);
					outersize = packet.packEOInt(buf[0].charCodeAt());
					if (outersize) {
						fData.curPos += 12 * outersize;
					}
					
					buf = readBuf(fData, 1);
					outersize = packet.packEOInt(buf[0].charCodeAt());
					
					for (var i = 0; i < outersize; i++) {
						buf = readBuf(fData, 2);
						var yloc = packet.packEOInt(buf[0].charCodeAt());
						innersize = packet.packEOInt(buf[1].charCodeAt());
						
						for (var ii = 0; ii < innersize; ii++) {
							buf = readBuf(fData, 2);
							var xloc = packet.packEOInt(buf[0].charCodeAt());
							var spec = packet.packEOInt(buf[1].charCodeAt())
							
							var tile = this.getTile(xloc, yloc);
							tile.tilespec = spec;
							this.setTile(xloc, yloc, tile);
							
							if (spec === structs.tileSpec.chest) {
								this.chests.push(mapChest(xloc, yloc));
							}
							
							if (spec === structs.tileSpec.spikes1) {
								this.has_timed_spikes = true;
							}
						}
					}
					
					buf = readBuf(fData, 1);
					outersize = packet.packEOInt(buf[0].charCodeAt());
					for (var i = 0; i < outersize; i++) {
						buf = readBuf(fData, 2);
						var yloc = packet.packEOInt(buf[0].charCodeAt());
						innersize = packet.packEOInt(buf[1].charCodeAt());
						
						for (var ii = 0; ii < innersize; ii++) {
							buf = readBuf(fData, 8);
							var xloc = packet.packEOInt(buf[0].charCodeAt());
							
							var map = packet.packEOInt(buf[1].charCodeAt(), buf[2].charCodeAt());
							var x = packet.packEOInt(buf[3].charCodeAt());
							var y = packet.packEOInt(buf[4].charCodeAt());
							var levelReq = packet.packEOInt(buf[5].charCodeAt());
							var spec = packet.packEOInt(buf[6].charCodeAt(), buf[7].charCodeAt());
							
							var tile = this.getTile(xloc, yloc);
							tile.warp = mapWarp(map, x, y, levelReq, spec);
							this.setTile(xloc, yloc, tile);
						}
					}
					
					fData.curPos = 0x2E;
					buf = readBuf(fData, 1);
					outersize = packet.packEOInt(buf[0].charCodeAt());
					var index = 0;
					for (let i = 0; i < outersize; i++) {
						buf = readBuf(fData, 8);
						let x = packet.packEOInt(buf[0].charCodeAt());
						let y = packet.packEOInt(buf[1].charCodeAt());
						let npcID = packet.packEOInt(buf[2].charCodeAt(), buf[3].charCodeAt());
						let spawnType = packet.packEOInt(buf[4].charCodeAt());
						let spawnTime = packet.packEOInt(buf[5].charCodeAt(), buf[6].charCodeAt());
						let amount = packet.packEOInt(buf[7].charCodeAt());
						
						for (let ii = 0; ii < amount; ii++) {
						    if (!this.inBounds(x, y)) {
						        console.log(`An NPC Spawned on a non existant title ${x},${y} on map ${this.id}`);
						        continue;
						    }

						    let newNPC = npc(this, npcID, x, y, spawnType, spawnTime, index++);
						    this.npcs.push(newNPC);
						    newNPC.spawn();
						}
					}
					
					buf = readBuf(fData, 1);
					outersize = packet.packEOInt(buf[0].charCodeAt());
					if (outersize) {
						fData.curPos += 4 * outersize;
					}
					
					buf = readBuf(fData, 1);
					outersize = packet.packEOInt(buf[0].charCodeAt());
					for (var i = 0; i < outersize; i++) {
						buf = readBuf(fData, 12);
						var x = packet.packEOInt(buf[0].charCodeAt());
						var y = packet.packEOInt(buf[1].charCodeAt());
						var slot = packet.packEOInt(buf[4].charCodeAt());
						var itemID = packet.packEOInt(buf[5].charCodeAt(), buf[6].charCodeAt());
						var time = packet.packEOInt(buf[7].charCodeAt(), buf[8].charCodeAt());
						var amount = packet.packEOInt(buf[9].charCodeAt(), buf[10].charCodeAt(), buf[11].charCodeAt());
						
						// if (itemID !== this.world.eif.get(itemID).id) {
						// 	console.log('A chest spawn on map ' + this.id + ' uses a non-existent item (#' + itemID + ' at ' + x + 'x' + y + ')')
						// }
						
						var chestIndex = this.chests.indexOf(this.chests.filter(function (chest) {
							return chest.x === x && chest.y === y;
						})[0]);
						
						if (chestIndex > -1) {
							var now = new Date();
							var spawn = {
								slot: slot + 1,
								time: time,
								last_taken: now,
								item: {
									id: itemID,
									amount: amount
								}
							};
							
							this.chests[chestIndex].spawns.push(spawn);
							this.chests[chestIndex].slots = Math.max(this.chests[chestIndex].slots, slot + 1);
						} else {
							// console.log('A chest spawn on map ' + this.id + ' points to a non-chest (' + this.world.eif.get(itemID).name + ' x' + amount + ' at ' + x + 'x' + y + ')')
						}
					}
					
					this.filesize = fData.length;
					this.exists = true;
				}
			} catch (e) {
				console.log('error loading map ' + this.id);
			}
		}
	};
	
	map.load();
	
	if (map.chests.length > 0) {
		setInterval(function () {
			spawnChests(map);
		}, 60 * 1000);
	}
	
	return map;
}

module.exports = Map;