import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { CreateGraphDto } from './dto/create-graph.dto';
import { PointEntity } from './entities/point.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { EdgeEntity } from './entities/edge.entity';
import { GraphEntity } from './entities/graph.entity';
import { Graph } from './helpers/handle-graph';

@Injectable()
export class GraphService {
  constructor(
    @InjectRepository(PointEntity)
    private pointRepository: Repository<PointEntity>,
    @InjectRepository(EdgeEntity)
    private edgeRepository: Repository<EdgeEntity>,
    @InjectRepository(GraphEntity)
    private graphRepository: Repository<GraphEntity>,
    private dataSource: DataSource,
  ) {}

  // ... [importações e declarações]

  async createGraph(data: CreateGraphDto) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    const createGraph = await queryRunner.manager.save(GraphEntity, {
      name: 'myGraph',
    });
    const pointsToBeCreated: PointEntity[] = [];

    for (const point of data.vertices) {
      // Supondo que 'vertexId' seja um identificador único para cada ponto

      if (!pointsToBeCreated.find((p) => p.id === point.vertexId)) {
        pointsToBeCreated.push({
          id: undefined,
          graph: createGraph,
          location: point.data,
          name: 'default',
        });
      } else {
        throw new ConflictException(
          `Vertex ${point.vertexId} already exists in this graph`,
        );
      }
    }

    const edgesToBeCreated: EdgeEntity[] = [];

    for (const edge of data.edges) {
      if (
        !edgesToBeCreated.find(
          (e) =>
            e.origin.id === edge.originId && e.destiny.id === edge.destinyId,
        )
      ) {
        const originVertex = data.vertices.find(
          (p) => p.vertexId === edge.originId,
        );
        const destinyVertex = data.vertices.find(
          (p) => p.vertexId === edge.destinyId,
        );

        if (!originVertex || !originVertex) {
          throw new BadRequestException(
            'Vertex not found in the vertices array',
          );
        }

        const originPoint: PointEntity = pointsToBeCreated.find(
          (p) => p.location === originVertex.data,
        );

        const destinyPoint: PointEntity = pointsToBeCreated.find(
          (p) => p.location === destinyVertex.data,
        );

        edgesToBeCreated.push({
          id: undefined,
          name: 'default',
          origin: originPoint,
          destiny: destinyPoint,
          line: {
            type: 'LineString',
            coordinates: [
              originVertex.data.coordinates,
              destinyVertex.data.coordinates,
            ],
          },
          distance: 0,
          graph: createGraph,
        });
      } else {
        throw new BadRequestException(
          `Already exists an edge between
             ${edge.originId} e ${edge.destinyId}`,
        );
      }
    }

    try {
      await queryRunner.manager.save(PointEntity, pointsToBeCreated);
      await queryRunner.manager.save(
        EdgeEntity,
        edgesToBeCreated.map((edge) => {
          return {
            origin: edge.origin,
            destiny: edge.destiny,
            name: edge.name,
            graph: createGraph,
            line: edge.line,
            distance: edge.distance,
          };
        }),
      );
      await queryRunner.commitTransaction();
      return this.readGraph(createGraph.id);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async readGraph(id: number) {
    try {
      const graph = await this.graphRepository.findOne({
        where: {
          id,
        },
      });
      if (!graph) throw new Error('Graph not found');
      const edges = await this.edgeRepository.find({
        where: {
          graph: { id },
        },
        relations: ['origin', 'destiny'],
      });
      if (!edges) throw new Error('Graph not found');
      const points = await this.pointRepository.find({
        where: {
          graph: { id },
        },
      });
      if (!points) throw new Error('Graph not found');

      return {
        id: graph.id,
        name: graph.name,
        vertices: points.map((point) => {
          return {
            id: point.id,
            name: point.name,
            location: point.location,
          };
        }),
        edges: edges.map((edge) => {
          return {
            id: edge.id,
            name: edge.name,
            origin: {
              id: edge.origin.id,
              location: edge.origin.location,
            },
            destiny: {
              id: edge.destiny.id,
              location: edge.destiny.location,
            },
          };
        }),
      };
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  async shortestPath(id: number, originId: number, destinyId: number) {
    try {
      originId = Number(originId);
      destinyId = Number(destinyId);

      const graphPathsExists = await this.verifyPathGraph(
        id,
        originId,
        destinyId,
      );
      if (!graphPathsExists) return;

      const graph = new Graph();

      const edges: any[] = await this.edgeRepository.find({
        where: {
          graph: { id },
        },
        relations: ['origin', 'destiny'],
      });

      const points: any = await this.pointRepository.find({
        where: {
          graph: { id },
        },
      });

      // Adiciona os vértices e arestas ao grafo

      points.map((point) => {
        graph.addVertex(point.id, point.location.coordinates);
      });

      edges.map((edge) => {
        const edgeLenght = edge.line.coordinates.reduce((acc, curr, index) => {
          if (index === 0) return acc;
          const [x1, y1] = edge.line.coordinates[index - 1];
          const [x2, y2] = curr;
          const x = x2 - x1;
          const y = y2 - y1;
          return acc + Math.sqrt(x * x + y * y);
        }, 0);
        this.getDistanceBetweenPoints(
          edge.origin.location.coordinates,
          edge.destiny.location.coordinates,
        );

        graph.addEdge(edge.origin.id, edge.destiny.id, edgeLenght);
      });

      // Encontra o melhor caminho

      const bestPath = graph.findBestPath({
        originId,
        destinyId,
      });

      return bestPath.map((path) => {
        const newPoint = points.find((point) => point.id === path);
        return {
          id: newPoint.id,
          name: newPoint.name,
          location: newPoint.location,
        };
      });
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  async allPaths(
    id: number,
    originId: number,
    destinyId: number,
    limitStop: number,
  ) {
    originId = Number(originId);
    destinyId = Number(destinyId);

    const graphPathsExists = await this.verifyPathGraph(
      id,
      originId,
      destinyId,
    );
    if (!graphPathsExists) return;

    const graph = new Graph();

    const edges: any[] = await this.edgeRepository.find({
      where: {
        graph: { id },
      },
      relations: ['origin', 'destiny'],
    });

    const points: any = await this.pointRepository.find({
      where: {
        graph: { id },
      },
    });

    // Adiciona os vértices e arestas ao grafo

    points.map((point) => {
      graph.addVertex(point.id, point.location.coordinates);
    });

    edges.map((edge) => {
      const edgeLenght = edge.line.coordinates.reduce((acc, curr, index) => {
        if (index === 0) return acc;
        const [x1, y1] = edge.line.coordinates[index - 1];
        const [x2, y2] = curr;
        const x = x2 - x1;
        const y = y2 - y1;
        return acc + Math.sqrt(x * x + y * y);
      }, 0);

      graph.addEdge(edge.origin.id, edge.destiny.id, edgeLenght);
    });

    // Encontra todos os caminhos

    const allPaths = graph.listAllPaths({
      originId,
      destinyId,
    });

    // Retorna os caminhos com no máximo 'limitStop' paradas

    return allPaths.map((path, index) => {
      path.length <= limitStop + 2 && {
        route: index + 1,
        path: path.map((vertexId) => {
          const newPoint = points.find((point) => point.id === vertexId);
          return {
            id: newPoint.id,
            name: newPoint.name,
            location: newPoint.location,
          };
        }),
      };
    });
  }

  async verifyPathGraph(id: number, originId: number, destinyId: number) {
    // Verifica se os pontos existem no grafo

    const originExists = await this.pointRepository.findOne({
      where: {
        id: originId,
        graph: { id },
      },
    });

    const destinyExists = await this.pointRepository.findOne({
      where: {
        id: destinyId,
        graph: { id },
      },
    });

    // Verifica se o grafo existe

    const graphExists = await this.graphRepository.findOne({
      where: {
        id,
      },
    });

    if (!graphExists) throw new BadRequestException('Graph not found');

    if (!originExists || !destinyExists)
      throw new BadRequestException('Invalid origin or destiny');

    return true;
  }

  async deleteGraph(id: number) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const graph = await this.graphRepository.findOne({
        where: {
          id,
        },
      });

      if (!graph) throw new BadRequestException('Graph not found');

      await queryRunner.manager.delete(EdgeEntity, {
        graph: { id },
      });

      await queryRunner.manager.delete(PointEntity, {
        graph: { id },
      });

      await queryRunner.manager.delete(GraphEntity, {
        id,
      });

      await queryRunner.commitTransaction();

      return {
        message: 'Graph deleted',
      };
    } catch (error) {
      console.log(error);
      await queryRunner.rollbackTransaction();
      throw new BadRequestException('Error while deleting graph');
    }
  }

  async getDistanceBetweenPoints(
    originCoordinates: number[],
    destinyCoordinates: number[],
  ) {
    const distance = await this.dataSource.query(
      `SELECT ST_Distance(ST_Transform('SRID=4326;POINT($1, $2)'::geometry, 3857),
            ST_Transform('SRID=4326;POINT($3, $4)'::geometry, 3857)
          );`,
      [
        originCoordinates[0],
        originCoordinates[1],
        destinyCoordinates[0],
        destinyCoordinates[1],
      ],
    );
    console.log(distance);
    return distance;
  }
}
