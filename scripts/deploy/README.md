# Scripts de déploiement et de sauvegarde (VM)

## Sauvegarde de la base (J0-1)

- `backup_db.sh` : `pg_dump` au format custom depuis le conteneur `inventory-db`, vérification de l'archive, rétention 14 jours dans `~/backups/inventaire`.
- `restore_db.sh <fichier.dump>` : arrête l'API, restaure (`--clean --if-exists`), redémarre l'API. Demande confirmation.

Installation du minuteur (utilisateur `admintsf` sur la VM) :

```bash
mkdir -p ~/.config/systemd/user
cp scripts/deploy/systemd/inventaire-backup.* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now inventaire-backup.timer
loginctl enable-linger "$USER"        # pour que le minuteur tourne sans session ouverte
systemctl --user list-timers | grep inventaire
```

Test immédiat : `systemctl --user start inventaire-backup.service && ls -lh ~/backups/inventaire`.

Test de restauration (à faire une fois, hors heures de comptage) : `./scripts/deploy/restore_db.sh ~/backups/inventaire/<dernier>.dump`
puis vérifier dans l'application que les boutiques, zones et comptages sont présents.

## Jeton applicatif (J1-1)

1. `cp secrets.env.example secrets.env` puis remplacer les deux valeurs par la sortie de `openssl rand -hex 32` (même valeur pour les deux lignes).
2. `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`.
3. Vérifier : `curl -k https://localhost/api/health` répond ; `curl http://<ip>:8080/api/health` doit échouer (port non publié).

`secrets.env` n'est jamais versionné ; `pull_and_rebuild.sh` fait un `git reset --hard` qui ne le touche pas.
