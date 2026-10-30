using System;
using CineBoutique.Inventory.Api.Tests.Fixtures;
using CineBoutique.Inventory.Api.Tests.Infra;
using FluentMigrator.Runner;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace CineBoutique.Inventory.Api.Tests.Infrastructure
{
  // Collection xUnit qui désactive le parallélisme et assure MigrateUp() une fois
  [Xunit.CollectionDefinition("db", DisableParallelization = true)]
  public sealed class DbCollection :
    Xunit.ICollectionFixture<PostgresContainerFixture>,
    Xunit.ICollectionFixture<InventoryApiFixture>,
    Xunit.ICollectionFixture<DatabaseFixture>
  { }

  public sealed class DatabaseFixture : IDisposable
  {
    private readonly ServiceProvider? _sp;
    public DatabaseFixture()
    {
      if (!TestEnvironment.IsIntegrationBackendAvailable())
      {
        Console.WriteLine("[tests] DatabaseFixture: backend indisponible, migrations ignorées.");
        return;
      }

      var cfg = new ConfigurationBuilder()
        .AddJsonFile("appsettings.json", optional: true)
        .AddEnvironmentVariables()
        .Build();

      // TEST_DB_CONN (CI, poste de dev) ou conteneur Testcontainers en priorité : appsettings.json ne décrit pas la base de test.
      var cs = TestDbOptions.ExternalConnectionString
               ?? PostgresContainerFixture.Instance?.ConnectionString
               ?? cfg.GetConnectionString("Default")
               ?? Environment.GetEnvironmentVariable("ConnectionStrings__Default")
               ?? string.Empty;

      if (string.IsNullOrWhiteSpace(cs))
      {
        Console.WriteLine("[tests] DatabaseFixture: aucune chaîne de connexion fournie, migrations ignorées.");
        return;
      }

      var services = new ServiceCollection()
        .AddFluentMigratorCore()
        .ConfigureRunner(rb => rb
          .AddPostgres()
          .WithGlobalConnectionString(cs)
          // IMPORTANT : assembly des migrations infra
          .ScanIn(typeof(CineBoutique.Inventory.Infrastructure.MigrationsMarker).Assembly).For.Migrations()
        )
        .AddLogging(lb => lb.AddFluentMigratorConsole());

      _sp = services.BuildServiceProvider(validateScopes: false);

      using var scope = _sp.CreateScope();
      var runner = scope.ServiceProvider.GetRequiredService<IMigrationRunner>();
      runner.MigrateUp();  // <-- Exécute toutes les migrations avant les tests
    }

    public void Dispose() => _sp?.Dispose();
  }
}
